import { dialog } from "electron";
import { IPC, type ActivationScope } from "@pi-desktop/shared";
import { isTemplateName, scaffold } from "@pi-desktop/plugin-devkit";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { BrowserHost } from "../browser-host";
import type { HostProcess } from "../host-process";
import { BROWSER_PLUGIN_ID } from "../browser-host";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import { PluginViewHost } from "../plugin-view-host";
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
        if (!plugin?.settings?.length || !plugins.getLoaded(plugin.id)) return withExtension;
        try {
          const settings = await plugins.getPluginSettings(plugin.id);
          return { ...withExtension, settings };
        } catch {
          return withExtension;
        }
      }),
    );
    return { ...result, plugins: pluginsWithSettings };
  });

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
    const path = result.filePaths[0];
    const loaded = await host.call<{ plugin: any }>("plugins.loadDev", { path });
    await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], {
      development: true,
    });
    if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "loadDev",
      pluginId: loaded.plugin?.id,
    });
    return loaded;
  });

  handle(IPC.invoke.pluginReload, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const listed = await host.call<{ plugins: any[] }>("plugins.list");
    const plugin = (listed.plugins ?? []).find((candidate) => candidate?.id === id);
    if (!plugin?.path) throw new Error(`PLUGIN_NOT_FOUND: ${id}`);
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

  // Scaffold a starter plugin and load it as a dev plugin in one step (D171),
  // so "I want to write a plugin" never starts with an empty folder.
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
      const loaded = await host.call<{ plugin: any }>("plugins.loadDev", {
        path: dir,
      });
      await plugins.loadFromPath(dir, loaded.plugin?.permissions ?? [], {
        development: true,
      });
      plugins.watchDevPlugin(created.id);
      for (const toast of plugins.drainToasts()) {
        sendToRenderer(IPC.event.toast, { message: toast });
      }
      return {
        id: created.id,
        name: created.name,
        dir: created.dir,
        files: created.files,
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

