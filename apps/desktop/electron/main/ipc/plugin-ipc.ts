import { dialog } from "electron";
import { IPC, type ActivationScope } from "@pi-desktop/shared";
import { isTemplateName, scaffold } from "@pi-desktop/plugin-devkit";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { BrowserHost } from "../browser-host";
import type { HostProcess } from "../host-process";
import { BROWSER_PLUGIN_ID } from "../browser-host";
import type { Logger } from "../logger";
import {
  readDevPluginDeclaration,
  widenedFsScope,
  type PluginRuntime,
} from "../plugin-runtime";
import { PluginViewHost } from "../plugin-view-host";
import { rendererCallError } from "../plugin-renderer-extension";
import type { IpcRegistrar } from "./types";

export type PluginIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  plugins: PluginRuntime;
  agentExtensions: AgentExtensionBridge;
  browserHost: BrowserHost;
  pluginViews: PluginViewHost;
  pluginScopes: Map<string, ActivationScope>;
  rememberPluginScopes: (list: any[]) => void;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  logger: Pick<Logger, "app">;
};

/** Register plugin lifecycle, settings and installation channels. */
export function registerPluginIpc({
  registrar,
  getHost,
  plugins,
  agentExtensions,
  browserHost,
  pluginViews,
  pluginScopes,
  rememberPluginScopes,
  sendToRenderer,
  logger,
}: PluginIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };

  /**
   * Register a development plugin folder, load it with the permissions the user
   * just approved, and arm the watcher whose ceiling is that approval.
   *
   * `plugins.loadDev` rewrites the registry row from the manifest, so the row
   * always states the current declaration; `loadFromPath` filters the approval
   * through that declaration, so an answer can never exceed the request.
   */
  const loadDevPlugin = async (
    path: string,
    grantedPermissions: string[] = [],
    reason: "loadDev" | "reload",
  ) => {
    if (!host) throw new Error("host unavailable");
    const loaded = await host.call<{ plugin: any }>("plugins.loadDev", { path });
    await plugins.loadFromPath(path, grantedPermissions, { development: true });
    if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged, {
      reason,
      pluginId: loaded.plugin?.id,
    });
    return loaded;
  };

  /** A development plugin folder as a review the renderer can render. */
  const reviewFor = (
    path: string,
    kind: "load" | "reload",
    addedPermissions: string[] = [],
  ) => {
    const declared = readDevPluginDeclaration(path);
    return {
      kind,
      path,
      id: declared.manifest.id,
      name: declared.manifest.name,
      version: declared.manifest.version,
      permissions: declared.permissions,
      addedPermissions,
    };
  };

  /**
   * What a manifest edit asks for beyond the current approval. Both the manual
   * reload and the hot reload answer this the same way, so a save and a click
   * cannot disagree about whether the user has to decide.
   */
  const beyondApproval = (pluginId: string, path: string) => {
    const approval = plugins.devApproval(pluginId);
    const declared = readDevPluginDeclaration(path);
    if (!approval) {
      // Never reviewed in this session: the load itself is the review.
      return { declared, added: declared.permissions, widened: [] as string[] };
    }
    const ceiling = new Set(approval.permissions);
    return {
      declared,
      added: declared.permissions.filter((permission) => !ceiling.has(permission)),
      widened: widenedFsScope(approval.fs, declared.fs),
    };
  };
  handle(IPC.invoke.pluginList, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ plugins: any[] }>("plugins.list");
    rememberPluginScopes(result.plugins ?? []);
    const pluginsWithSettings = await Promise.all(
      (result.plugins ?? []).map(async (plugin) => {
        const extensionIds = plugins
          .getAgentExtensions()
          .filter((extension) => extension.pluginId === plugin?.id)
          .map((extension) => extension.id);
        const withExtension = extensionIds.length
          ? { ...plugin, agentExtension: agentExtensions.statusForPlugin(extensionIds) }
          : plugin;
        // The renderer host loads from the live load, never from the registry
        // row: a plugin that is not running has nothing to load.
        const renderer = plugin?.id ? plugins.rendererDescriptor(plugin.id) : undefined;
        const withRenderer = renderer ? { ...withExtension, renderer } : withExtension;
        if (!plugin?.settings?.length || !plugins.getLoaded(plugin.id)) return withRenderer;
        try {
          const settings = await plugins.getPluginSettings(plugin.id);
          return { ...withRenderer, settings };
        } catch {
          return withRenderer;
        }
      }),
    );
    return { ...result, plugins: pluginsWithSettings };
  });

  // Renderer extensions run in the main window only (`PluginRendererHost`),
  // so no other window may relay into a plugin's headless entry.
  registrar.handleWithEvent(
    IPC.invoke.pluginRendererCall,
    async (event, pluginId: unknown, method: unknown, args: unknown) => {
      registrar.assertMainWindowSender(event);
      if (typeof pluginId !== "string" || !pluginId || typeof method !== "string" || !method) {
        throw rendererCallError("INVALID_ARGUMENT", "pluginId and method are required");
      }
      return plugins.callRenderer(pluginId, method, args);
    },
  );

  handle(IPC.invoke.pluginSettingsGet, async (id: string) => {
    const settings = await plugins.getPluginSettings(String(id ?? ""));
    return { settings };
  });

  handle(
    IPC.invoke.pluginSettingsSet,
    async (payload: { id?: string; settings?: Record<string, unknown> }) => {
      const settings = await plugins.setPluginSettings(
        String(payload?.id ?? ""),
        payload?.settings ?? {},
      );
      sendToRenderer(IPC.event.pluginChanged,{
        reason: "settings",
        pluginId: String(payload?.id ?? ""),
      });
      return { settings };
    },
  );

  handle(IPC.invoke.pluginLoadDev, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    // Picking the folder is not the grant. The folder declares what it wants,
    // the user answers, and only then is anything registered or loaded.
    return { canceled: false, review: reviewFor(result.filePaths[0], "load") };
  });

  handle(
    IPC.invoke.pluginLoadDevConfirm,
    async (input: { path?: unknown; grantedPermissions?: unknown }) => {
      if (!host) throw new Error("host unavailable");
      const path = typeof input?.path === "string" ? input.path : "";
      if (!path) throw new Error("INVALID_PARAMS: path required");
      const granted = Array.isArray(input?.grantedPermissions)
        ? input.grantedPermissions.filter(
            (permission): permission is string => typeof permission === "string",
          )
        : [];
      const loaded = await loadDevPlugin(path, granted, "loadDev");
      return { ...loaded, grantedPermissions: granted };
    },
  );

  handle(IPC.invoke.pluginReload, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const listed = await host.call<{ plugins: any[] }>("plugins.list");
    const plugin = (listed.plugins ?? []).find((candidate) => candidate?.id === id);
    if (!plugin?.path) throw new Error(`PLUGIN_NOT_FOUND: ${id}`);
    if (plugin.source === "dev") {
      // A manifest edit is a request for more, and the approval is the answer:
      // it is never widened by loading. Ask the user first instead.
      const { added, widened } = beyondApproval(id, plugin.path);
      if (added.length || widened.length) {
        return {
          plugin,
          review: reviewFor(plugin.path, "reload", [...added, ...widened]),
        };
      }
    }
    await plugins.loadFromPath(plugin.path, plugin.permissions ?? [], {
      development: plugin.source === "dev",
    });
    if (plugin.source === "dev") plugins.watchDevPlugin(id);
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{ reason: "reload", pluginId: id });
    return { plugin };
  });

  handle(
    IPC.invoke.pluginReloadConfirm,
    async (input: { id?: unknown; grantedPermissions?: unknown }) => {
      if (!host) throw new Error("host unavailable");
      const id = typeof input?.id === "string" ? input.id : "";
      if (!id) throw new Error("INVALID_PARAMS: id required");
      const listed = await host.call<{ plugins: any[] }>("plugins.list");
      const plugin = (listed.plugins ?? []).find((candidate) => candidate?.id === id);
      if (!plugin?.path) throw new Error(`PLUGIN_NOT_FOUND: ${id}`);
      const granted = Array.isArray(input?.grantedPermissions)
        ? input.grantedPermissions.filter(
            (permission): permission is string => typeof permission === "string",
          )
        : [];
      const loaded = await loadDevPlugin(plugin.path, granted, "reload");
      return { ...loaded, grantedPermissions: granted };
    },
  );

  // Scaffold a starter plugin and load it as a dev plugin in one step (D171),
  // so "I want to write a plugin" never starts with an empty folder. The
  // scaffold only writes files; loading waits for the same review as a folder
  // picked by hand.
  handle(
    IPC.invoke.pluginCreateFromTemplate,
    async (req: { template?: string }) => {
      if (!host) throw new Error("host unavailable");
      const template = req?.template;
      if (!isTemplateName(template)) {
        throw new Error(`unknown plugin template: ${String(template)}`);
      }
      const picked = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) {
        return { canceled: true };
      }
      const dir = picked.filePaths[0];
      const created = await scaffold({ dir, template });
      return {
        id: created.id,
        name: created.name,
        dir: created.dir,
        files: created.files,
        review: reviewFor(dir, "load"),
      };
    },
  );

  handle(IPC.invoke.pluginInstallFromPath, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const path = result.filePaths[0];
    const installed = await host.call<{ result: any }>("plugins.installFromPath", {
      path,
      enable: true,
    });
    if (installed.result?.plugin?.enabled && installed.result?.plugin?.path) {
      await plugins.loadFromPath(
        installed.result.plugin.path,
        installed.result.plugin.permissions ?? [],
      );
    }
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "install",
      pluginId: installed.result?.plugin?.id,
    });
    return installed;
  });

  handle(IPC.invoke.pluginInstallFromPackage, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "PI Plugin", extensions: ["piplug", "zip"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const path = result.filePaths[0];
    const installed = await host.call<{ result: any }>("plugins.installFromPackage", {
      path,
      enable: true,
    });
    if (installed.result?.plugin?.enabled && installed.result?.plugin?.path) {
      await plugins.loadFromPath(
        installed.result.plugin.path,
        installed.result.plugin.permissions ?? [],
      );
    }
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "install",
      pluginId: installed.result?.plugin?.id,
    });
    return installed;
  });

  handle(IPC.invoke.pluginEnable, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ plugin: any }>("plugins.enable", { id });
    if (res.plugin?.path) {
      await plugins.loadFromPath(res.plugin.path, res.plugin.permissions ?? [], {
        development: res.plugin.source === "dev",
      });
      if (res.plugin.source === "dev") plugins.watchDevPlugin(id);
    }
    logger.app("plugin", "info", "plugin enabled", { pluginId: id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "enable", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginDisable, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    pluginViews.closePlugin(id);
    if (id === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
    await plugins.unload(id);
    logger.app("plugin", "info", "plugin disabled", { pluginId: id });
    const res = await host.call("plugins.disable", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "disable", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginUninstall, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    pluginViews.closePlugin(id);
    await plugins.unload(id);
    logger.app("plugin", "info", "plugin uninstalled", { pluginId: id });
    const res = await host.call("plugins.uninstall", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "uninstall", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginSetAutoUpdate, async (payload: { id: string; enabled: boolean }) => {
    if (!host) throw new Error("host unavailable");
    return host.call("plugins.setAutoUpdate", {
      id: payload.id,
      enabled: payload.enabled,
    });
  });

  handle(
    IPC.invoke.pluginSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call<{ plugin?: { id?: string; scope?: ActivationScope } }>(
        "plugins.setScope",
        { id: payload.id, scope: payload.scope },
      );
      // Keep the dispatch-path cache honest without waiting for the next list.
      if (res.plugin?.id && res.plugin.scope) {
        pluginScopes.set(res.plugin.id, res.plugin.scope);
      }
      logger.app("plugin", "info", "plugin scope changed", {
        pluginId: payload.id,
        data: { mode: payload.scope?.mode, projects: payload.scope?.projects?.length ?? 0 },
      });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "scope", pluginId: payload.id });
      return res;
    },
  );

  // --- MCP servers the user owns -------------------------------------------
  // host-core persists and validates; this side owns the connections, so every
  // mutation is followed by a refresh that drops stale ones.
}
