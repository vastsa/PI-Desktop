import { dialog, shell, type BrowserWindow } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  IPC,
  type ActivationScope,
  type BrowserState,
  type ModelBinding,
  type ThinkingLevel,
  type UiMessage,
} from "@pi-desktop/shared";
import type {
  PluginCompleteResult,
  PluginNativeNotificationInput,
  PluginNativeNotificationResult,
  PluginNotificationPermission,
} from "@pi-desktop/plugin-sdk";
import {
  asPluginThinkingLevel,
  listReadyPluginModels,
  parsePluginModelKey,
  pluginCompleteContext,
  pluginSessionContextFromSession,
} from "../plugin-agent-complete";
import {
  completeOneShot,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import { createFsConsentService } from "../plugin-fs-consent";
import { createDesktopConsentService } from "../plugin-desktop-consent";
import { PluginRuntime } from "../plugin-runtime";
import { UserMcpRuntime } from "../user-mcp";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  McpServerClient,
} from "../plugin-mcp";
import { PluginPanelHost } from "../plugin-panel-host";
import { PluginViewHost } from "../plugin-view-host";
import { BrowserPane } from "../browser-view";
import { BrowserHost, BROWSER_PLUGIN_ID } from "../browser-host";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { ClipboardHistory } from "../clipboard-history";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginAppearance } from "../../shared/plugin-panel-chrome";

export type PluginServicesDependencies = {
  dataDir: string;
  logger: Logger;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  stripWinLongPrefix: (path: string) => string;
  clipboardHistory: ClipboardHistory;
  getPluginNotificationPermission: () => PluginNotificationPermission;
  requestPluginNotificationPermission: () => Promise<PluginNotificationPermission>;
  showPluginNativeNotification: (
    input: PluginNativeNotificationInput,
  ) => Promise<PluginNativeNotificationResult>;
  getUpdaterLocale: () => string;
  getPluginPanelTheme: () => "light" | "dark";
  getAppearance: () => PluginAppearance;
  getWorkspacePath: () => string | null;
  isHostUnavailable: (error: unknown) => boolean;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  vendorOAuth: VendorOAuth;
  agentExtensions: AgentExtensionBridge;
};

export function createPluginServices({
  dataDir,
  logger,
  getMainWindow,
  getHost,
  sendToRenderer,
  safeOpenExternal,
  stripWinLongPrefix,
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  getUpdaterLocale,
  getPluginPanelTheme,
  getAppearance,
  getWorkspacePath,
  isHostUnavailable,
  resolveAgentRuntimeLaunch,
  vendorOAuth,
  agentExtensions,
}: PluginServicesDependencies) {
  const pluginPanels = new PluginPanelHost(
    async (pluginId, channel, payload, context) =>
      plugins.invokePanelBridge(pluginId, channel, payload, context),
    // A panel reaching for an undeclared host is the shape an exfiltration
    // attempt takes, so it is logged like a denied API call rather than dropped
    // silently in the network layer.
    ({ pluginId, url }) => {
      logger.app("plugin", "warn", "plugin.api", {
        pluginId,
        code: "PERMISSION_DENIED",
        data: { api: "panel.egress", ok: false, url, ts: Date.now() },
      });
    },
    (pluginId, channel, error) => {
      logger.app("plugin", "warn", "plugin.panel.bridge", {
        pluginId,
        code: (error as { code?: string })?.code ?? "PANEL_BRIDGE_FAILED",
        data: { channel, error: String(error) },
      });
    },
  );
  const callPluginSessionHost = async (
    method: string,
    pluginId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!getHost()) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const result = await getHost()!.call(method, { ...input, pluginId });
    const changed =
      (method === "plugin.session.import" &&
        (result as { imported?: unknown })?.imported === true) ||
      (method === "plugin.session.importBatch" &&
        Number((result as { imported?: unknown })?.imported ?? 0) > 0) ||
      (method === "plugin.session.rename" &&
        (result as { updated?: unknown })?.updated === true) ||
      (method === "plugin.session.delete" &&
        (result as { deleted?: unknown })?.deleted === true);
    if (changed) {
      sendToRenderer(IPC.event.sessionsChanged, { reason: method, pluginId });
    }
    return result;
  };
  const callPluginProjectHost = async (
    pluginId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!getHost()) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const result = await getHost()!.call<{
      project?: { id?: number; path?: string; name?: string };
    }>("projects.create", { ...input, pluginId });
    const project = result.project;
    if (!project || typeof project.id !== "number" || !project.path || !project.name) {
      throw Object.assign(new Error("invalid project response"), { code: "INTERNAL" });
    }
    return { projectId: project.id, path: project.path, name: project.name };
  };
  const plugins: PluginRuntime = new PluginRuntime({
    getWorkspacePath: () => {
      // Filled after host boots; temporary stub until services rebinding.
      return null;
    },
    showToast: (message) => sendToRenderer(IPC.event.toast, { message }),
    notify: (input) =>
      sendToRenderer(IPC.event.toast, {
        message: `${input.title}${input.body ? `: ${input.body}` : ""}`,
      }),
    getNotificationPermission: getPluginNotificationPermission,
    requestNotificationPermission: requestPluginNotificationPermission,
    showNativeNotification: showPluginNativeNotification,
    openExternal: async (url) => {
      await safeOpenExternal(url);
    },
    openPath: async (fullPath) => {
      const error = await shell.openPath(stripWinLongPrefix(fullPath));
      if (error) throw new Error(error);
    },
    revealPath: async (fullPath) => {
      shell.showItemInFolder(stripWinLongPrefix(fullPath));
    },
    readClipboard: async () => {
      const { clipboard } = await import("electron");
      return clipboard.readText();
    },
    writeClipboard: async (value) => {
      const { clipboard } = await import("electron");
      clipboard.writeText(value);
      clipboardHistory.recordText(value);
    },
    readClipboardHistory: async () => clipboardHistory.getHistory(),
    getLocale: () => getUpdaterLocale(),
    getAppearance: () => getAppearance(),
    openPanel: async (request) => {
      await pluginPanels.open({
        ...request,
        locale: getUpdaterLocale(),
        theme: getPluginPanelTheme(),
      });
    },
    closePanel: async (pluginId) => {
      await pluginPanels.close(pluginId);
    },
    // `net.fetch` is deliberately not overridden here: the runtime's own
    // implementation follows redirects by hand and re-checks the manifest
    // egress allowlist before every hop. A plain `fetch` service would let an
    // allowlisted host 30x the request straight out to an undeclared one.
    audit: (entry) => {
      logger.app("plugin", "info", "plugin.api", entry);
    },
    // A file access the manifest did not cover is decided by the user, natively
    // and synchronously: the plugin's call is still waiting on the answer, so
    // there is no window in which the access happens before consent.
    confirmFsAccess: createFsConsentService({
      getWindow: () => getMainWindow(),
      getLocale: () => getUpdaterLocale(),
    }),
    // A dangerous desktop operation (session delete, permission-mode change,
    // tool approval) requested by a plugin is decided by the user in a native
    // dialog that names the catalog operation, never plugin-authored text.
    confirmDesktopControl: createDesktopConsentService({
      getWindow: () => getMainWindow(),
      getLocale: () => getUpdaterLocale(),
    }),
    // The OS trash is what makes a plugin delete recoverable, and it is the
    // reason none of the user's data is copied anywhere by us.
    trashItem: async (fullPath) => {
      await shell.trashItem(fullPath);
    },
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    },
    // Refused under every root and grant: the data directory holds provider keys
    // and the session store, and a plugin reaching it would undo every other
    // limit on this list.
    protectedPaths: () => [dataDir],
    listModels: async () => {
      // Same D080 degrade as skills/MCP/subagent catalog reads: a dead
      // transport is expected during shutdown and supervised restarts.
      if (!getHost()?.isAvailable()) return [];
      try {
        const listed = await getHost()!.call<{ providers: Array<{
          id: string;
          name: string;
          enabled?: boolean;
          hasSecret?: boolean;
          hasOauth?: boolean;
          authKind?: string;
          supportsReasoning?: boolean;
          supportedThinkingLevels?: ThinkingLevel[];
          defaultModelId?: string;
          models?: ModelBinding[];
        }> }>("providers.list", { includeDisabled: false });
        return listReadyPluginModels(listed.providers ?? []);
      } catch (error) {
        if (!isHostUnavailable(error)) throw error;
        return [];
      }
    },
    getSessionContext: async (sessionId, stripToolName) => {
      if (!getHost()) {
        throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
      }
      const detail = await getHost()!.call<{
        session?: {
          messages?: UiMessage[];
          compaction?: import("@pi-desktop/shared").ContextCompactionRecord;
          providerId?: string;
          modelId?: string;
          thinkingLevel?: string;
        } | null;
      }>("session.get", { id: sessionId });
      return pluginSessionContextFromSession(sessionId, detail?.session, stripToolName);
    },
    session: {
      list: (pluginId, input) => callPluginSessionHost("plugin.session.list", pluginId, input),
      get: (pluginId, input) => callPluginSessionHost("plugin.session.get", pluginId, input),
      listMessages: (pluginId, input) =>
        callPluginSessionHost("plugin.session.listMessages", pluginId, input),
      import: (pluginId, input) => callPluginSessionHost("plugin.session.import", pluginId, input),
      importBatch: (pluginId, input) =>
        callPluginSessionHost("plugin.session.importBatch", pluginId, input),
      rename: (pluginId, input) => callPluginSessionHost("plugin.session.rename", pluginId, input),
      delete: (pluginId, input) => callPluginSessionHost("plugin.session.delete", pluginId, input),
    },
    project: {
      create: (pluginId, input) => callPluginProjectHost(pluginId, input),
    },
    complete: async (input): Promise<PluginCompleteResult> => {
      if (!getHost()) {
        throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
      }
      const parsed = parsePluginModelKey(input.modelKey);
      if (!parsed) {
        throw Object.assign(new Error("modelKey must be providerId/modelId"), {
          code: "INVALID_ARGUMENT",
        });
      }
      const thinkingLevel = asPluginThinkingLevel(input.thinkingLevel);
      const settings = await getHost()!.call<any>("settings.get");
      const launchSessionId = input.sessionId || `plugin-complete:${crypto.randomUUID()}`;
      const session = input.sessionId
        ? (await getHost()!.call<{ session?: any }>("session.get", { id: input.sessionId })).session
        : {};
      const launch = await resolveAgentRuntimeLaunch(launchSessionId, session ?? {}, settings, {
        mode: "agent",
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        thinkingLevel,
      });
      const runtimeProvider = {
        ...launch.sidecarParams.provider,
        ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
          ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
          : {}),
      } as RuntimeProviderConfig;
      const sessionContext = input.includeSessionContext
        ? pluginSessionContextFromSession(
            String(input.sessionId ?? ""),
            session,
            input.stripToolName,
          )
        : undefined;
      const context = pluginCompleteContext({
        modelKey: input.modelKey,
        thinkingLevel: input.thinkingLevel,
        system: input.system,
        messages: input.messages,
        includeSessionContext: input.includeSessionContext,
        sessionContext,
      });
      const result = await completeOneShot(
        runtimeProvider,
        context,
        launch.sidecarParams.thinkingLevel,
        { signal: input.signal, sessionId: launchSessionId },
      );
      return {
        text: result.text,
        modelKey: `${launch.providerId}/${launch.modelId}`,
        thinkingLevel: launch.sidecarParams.thinkingLevel,
        usage: result.usage,
      };
    },
    // A plugin host process dying is contained: contributions are already
    // deregistered by the runtime, we only have to tell the user and the UI.
    onPluginCrash: ({ pluginId, exitCode }) => {
      logger.app("plugin", "error", "plugin host process crashed", {
        pluginId,
        code: "PLUGIN_CRASHED",
        data: { exitCode },
      });
      // No toast here: the runtime already raised one through `showToast` on the
      // same code path, and a second identical message reads as two failures.
      // The view's page outlived the process behind its bridge, so it is a dead
      // surface. Drop it; the renderer re-opens it on the pluginChanged event if
      // the tab is still active and the plugin came back.
      pluginViews.closePlugin(pluginId);
      if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
      sendToRenderer(IPC.event.pluginChanged,{ reason: "crash", pluginId });
    },
    // Supervision state is UI-only: the runtime owns restarts, the renderer just
    // reflects what happened.
    onServiceChange: (status) => {
      logger.app("plugin", "info", "plugin.service", {
        pluginId: status.pluginId,
        data: { serviceId: status.serviceId, state: status.state, restarts: status.restarts },
      });
      sendToRenderer(IPC.event.pluginChanged,{
        reason: "service",
        pluginId: status.pluginId,
      });
    },
    // Hot reload happens without anyone asking for it, so it has to report
    // itself: the plugins page reads status from the host, not from the edit.
    onPluginReloaded: ({ pluginId, name, ok, message }) => {
      logger.app("plugin", ok ? "info" : "error", "development plugin reloaded", {
        pluginId,
        data: { ok, message },
      });
      sendToRenderer(IPC.event.toast, {
        message: ok ? `Reloaded ${name}` : `Reload failed: ${name} — ${message ?? ""}`,
      });
      // Views were loaded from the previous revision of the plugin's files.
      pluginViews.closePlugin(pluginId);
      if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
      sendToRenderer(IPC.event.pluginChanged,{ reason: "reload", pluginId });
    },
  });
  const userMcp = new UserMcpRuntime({
    createClient: (config) => new McpServerClient(config),
    connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
    callTimeoutMs: MCP_CALL_TIMEOUT_MS,
    audit: (entry) => logger.app("plugin", "info", "mcp.api", entry),
    log: (level, message, data) => logger.app("plugin", level, message, { data }),
  });
  /**
   * Activation scopes for the loaded plugins, keyed by plugin id.
   *
   * host-core is the source of truth; this cache exists because scope has to be
   * consulted on every session assembly and every tool dispatch, which are hot
   * paths that must not wait on an RPC round trip. It is refreshed whenever the
   * plugin list is read.
   */
  const pluginScopes = new Map<string, ActivationScope>();
  /**
   * Project path per live session, so a tool dispatch can be scope-checked
   * without asking host-core which project the session belongs to. Two windows
   * can hold sessions on different projects, so this cannot be a single value.
   */
  const sessionProjects = new Map<string, string | null>();
  const emitBrowserState = (state: BrowserState) => {
    sendToRenderer(IPC.event.browserState, state);
    pluginPanels.broadcast("browser:state", state);
    pluginViews.broadcast("browser:state", state);
  };
  const browserPane = new BrowserPane(emitBrowserState);
  const pluginViews = new PluginViewHost(({ pluginId, url }) => {
    logger.app("plugin", "warn", "plugin.api", {
      pluginId,
      code: "PERMISSION_DENIED",
      data: { api: "view.egress", ok: false, url, ts: Date.now() },
    });
  });
  pluginPanels.addSenderResolver((senderId) => pluginViews.pluginIdForSender(senderId));
  const browserHost = new BrowserHost({
    pane: browserPane,
    isPluginLoaded: (pluginId) => Boolean(plugins.getLoaded(pluginId)),
    getFileRoot: async (sessionId) => {
      if (sessionId) {
        try {
          const res = (await getHost()?.call("session.get", { id: sessionId })) as
            | { session: { projectPath?: string } | null }
            | undefined;
          const path = res?.session?.projectPath?.trim();
          if (path) return path;
        } catch {
          // Fall through to the visible workspace.
        }
      }
      return getWorkspacePath();
    },
    getScratchDir: (sessionId) => {
      if (!sessionId) return null;
      const root =
        process.env.PI_DESKTOP_DATA_DIR?.trim() ||
        join(homedir(), ".pi-desktop");
      return join(root, "scratch", sessionId);
    },
    onState: emitBrowserState,
  });
  pluginViews.onSurface = (surface) => {
    browserHost.setChromeSurface(surface);
  };
  plugins.setServices({
    agentExtensionsChanged: () =>
      sendToRenderer(IPC.event.pluginChanged, { reason: "agentExtensions" }),
    browser: {
      navigate: (input, sessionId) => browserHost.navigate(input, sessionId),
      action: (action) => browserHost.action(action),
      setBounds: (pluginId, hole) => browserHost.setGuestHole(pluginId, hole),
      setVisible: (pluginId, visible) => browserHost.setGuestVisible(pluginId, visible),
      getState: () => browserHost.getState(),
      openExternal: () => browserHost.openExternal(),
      snapshot: () => browserHost.snapshot(),
      screenshot: (input, sessionId) => browserHost.screenshot(input, sessionId),
      click: (uid) => browserHost.click(uid),
      fill: (uid, text) => browserHost.fill(uid, text),
      evaluate: (expression) => browserHost.evaluate(expression),
      console: (limit) => browserHost.console(limit),
      cdp: (method, params) => browserHost.cdpCommand(method, params),
    },
    onPluginUnload: (pluginId) => {
      if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
    },
  });
  return {
    plugins,
    userMcp,
    pluginScopes,
    sessionProjects,
    emitBrowserState,
    pluginPanels,
    pluginViews,
    browserHost,
    browserPane,
  };
}
