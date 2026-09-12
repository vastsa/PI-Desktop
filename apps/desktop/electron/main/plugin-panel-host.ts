import { BrowserWindow, ipcMain, session } from "electron";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { isNetUrlAllowed } from "@pi-desktop/plugin-sdk";
import {
  isPluginPanelWindowControlAction,
  PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL,
  PLUGIN_PANEL_WINDOW_STATE_CHANNEL,
  PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX,
  type PluginPanelTheme,
  type PluginPanelWindowControlAction,
} from "../shared/plugin-panel-chrome";

export type PluginPanelOpenRequest = {
  pluginId: string;
  title: string;
  locale: string;
  theme: PluginPanelTheme;
  width: number;
  height: number;
  htmlPath: string;
  /**
   * Egress allowlist from `manifest.net.domains`. A panel is a full web page:
   * `sandbox: true` removes Node, not the network, so without this the panel is
   * an unmetered outbound channel that bypasses the `net.fetch` permission.
   */
  netDomains?: readonly string[];
  /** Allows microphone audio for plugins with the explicit ui.microphone grant. */
  allowMicrophone?: boolean;
  /** Adds a development-only reminder for the non-clickable drag band. */
  development?: boolean;
};

/** Schemes a panel may always load: its own bundle and devtools plumbing. */
const PANEL_LOCAL_SCHEMES = new Set([
  "file:",
  "data:",
  "blob:",
  "devtools:",
  "chrome-extension:",
]);

const DROPPED_PATH_TTL_MS = 30_000;


type BridgeHandler = (
  pluginId: string,
  channel: string,
  payload?: Record<string, unknown>,
  context?: { droppedPath?: string },
) => Promise<unknown>;

/** Reports an egress attempt a panel was not allowed to make. */
export type PluginPanelBlockedRequest = (input: {
  pluginId: string;
  url: string;
}) => void;

/**
 * Confine everything a plugin's web contents can reach to its declared domains.
 *
 * Shared by the detached panel window and the docked work-panel view: both are
 * full web pages under the same plugin identity, so one policy governs both.
 * Registering again on the same persisted partition replaces the previous
 * handlers, so re-opening re-reads the current allowlist rather than stacking
 * filters.
 */
export function applyPluginEgressPolicy(
  ses: Electron.Session,
  input: {
    pluginId: string;
    netDomains?: readonly string[];
    allowMicrophone?: boolean;
    onBlockedRequest?: PluginPanelBlockedRequest;
  },
): void {
  const domains = input.netDomains ?? [];
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let scheme = "";
    try {
      scheme = new URL(details.url).protocol;
    } catch {
      // An unparseable URL cannot be matched against the allowlist; drop it.
      callback({ cancel: true });
      return;
    }
    if (PANEL_LOCAL_SCHEMES.has(scheme)) {
      callback({ cancel: false });
      return;
    }
    if (isNetUrlAllowed(details.url, domains)) {
      callback({ cancel: false });
      return;
    }
    input.onBlockedRequest?.({ pluginId: input.pluginId, url: details.url });
    callback({ cancel: true });
  });
  // A panel is denied device access by default. The only opt-in is an
  // audio-only media request for a plugin that declared ui.microphone.
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes =
      permission === "media" && "mediaTypes" in details ? details.mediaTypes : undefined;
    const audioOnly =
      Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
    callback(input.allowMicrophone === true && audioOnly);
  });
  ses.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    permission === "media" && input.allowMicrophone === true && details.mediaType === "audio",
  );
}

/** Persisted session partition shared by a plugin's panel window and views. */
export function pluginSessionPartition(pluginId: string): string {
  return `persist:pi-plugin-${pluginId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

/**
 * Hosts isolated plugin panel windows.
 * Each plugin panel gets a dedicated session partition and no Node integration.
 */
export class PluginPanelHost {
  private windows = new Map<string, BrowserWindow>();
  private bridge: BridgeHandler;
  private onBlockedRequest?: PluginPanelBlockedRequest;
  private handlerReady = false;
  /** Paths reported by the preload for a real drop, keyed by web contents. */
  private pendingDrops = new Map<number, Map<string, number>>();
  /**
   * Other owners of plugin web contents that may use the panel bridge — the
   * docked work-panel views. Kept separate from `windows` so window controls
   * stay window-only: a docked view must not be able to close the same
   * plugin's detached panel window.
   */
  private senderResolvers: Array<(senderId: number) => string | null> = [];
  /** Observer for failures of the fire-and-forget legacy sync bridge. */
  private onBridgeError?: (pluginId: string, channel: string, error: unknown) => void;

  constructor(
    bridge: BridgeHandler,
    onBlockedRequest?: PluginPanelBlockedRequest,
    onBridgeError?: (pluginId: string, channel: string, error: unknown) => void,
  ) {
    this.bridge = bridge;
    this.onBlockedRequest = onBlockedRequest;
    this.onBridgeError = onBridgeError;
    this.ensureHandlers();
  }

  /** Lets another host serve `pluginBridge` calls from its own web contents. */
  addSenderResolver(resolve: (senderId: number) => string | null): void {
    this.senderResolvers.push(resolve);
  }

  private ensureHandlers(): void {
    if (this.handlerReady) return;
    this.handlerReady = true;

    ipcMain.handle(
      "pi-plugin-panel-invoke",
      async (event, rawChannel: unknown, rawPayload: unknown) => {
        const pluginId = this.pluginIdForSender(event.sender.id);
        if (!pluginId) throw new Error("invalid panel invoker");
        const channel = String(rawChannel ?? "");
        const payload =
          rawPayload && typeof rawPayload === "object"
            ? (rawPayload as Record<string, unknown>)
            : undefined;
        const droppedPath =
          channel === "fs.registerDropped"
            ? this.consumeDroppedPath(event.sender.id, payload?.path)
            : undefined;
        return this.bridge(pluginId, channel, payload, droppedPath ? { droppedPath } : undefined);
      },
    );

    ipcMain.on("pi-plugin-panel-drop", (event, rawPaths: unknown) => {
      const pluginId = this.pluginIdForSender(event.sender.id);
      if (!pluginId || !Array.isArray(rawPaths)) return;
      this.recordDroppedPaths(
        event.sender.id,
        rawPaths.filter((value): value is string => typeof value === "string"),
      );
    });

    // Legacy sync bridge used by older sample panels.
    ipcMain.on(
      "pi-plugin-panel-bridge",
      (event, rawChannel: unknown, rawPayload: unknown) => {
        const pluginId = this.pluginIdForSender(event.sender.id);
        if (!pluginId) {
          event.returnValue = {
            ok: false,
            error: { code: "NOT_FOUND", message: "invalid panel invoker" },
          };
          return;
        }
        const channel = String(rawChannel ?? "");
        const payload =
          rawPayload && typeof rawPayload === "object"
            ? (rawPayload as Record<string, unknown>)
            : undefined;
        // Sync IPC cannot await; kick async work and return ack. The bridge
        // rejects when the plugin is unloaded or times out, and a panel page
        // can call this at will, so the rejection must be observed here
        // rather than surfacing as an unhandled rejection in main.
        this.bridge(pluginId, channel, payload).catch((error) => {
          this.onBridgeError?.(pluginId, channel, error);
        });
        event.returnValue = { ok: true, accepted: true };
      },
    );

    ipcMain.handle(
      PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL,
      async (event, rawAction: unknown) => {
        const window = this.windowForSender(event.sender.id);
        if (!window) throw new Error("invalid panel window control invoker");
        if (!isPluginPanelWindowControlAction(rawAction)) {
          throw new Error("unsupported panel window control action");
        }
        this.applyWindowControl(window, rawAction);
        return {
          maximized: !window.isDestroyed() && window.isMaximized(),
        };
      },
    );
  }

  private pluginIdForSender(senderId: number): string | null {
    for (const [pluginId, win] of this.windows) {
      if (!win.isDestroyed() && win.webContents.id === senderId) return pluginId;
    }
    for (const resolve of this.senderResolvers) {
      const pluginId = resolve(senderId);
      if (pluginId) return pluginId;
    }
    return null;
  }

  private recordDroppedPaths(senderId: number, paths: readonly string[]): void {
    const now = Date.now();
    const pending = this.pendingDrops.get(senderId) ?? new Map<string, number>();
    for (const rawPath of paths.slice(0, 32)) {
      if (!rawPath) continue;
      pending.set(resolve(rawPath), now + DROPPED_PATH_TTL_MS);
    }
    if (pending.size) this.pendingDrops.set(senderId, pending);
  }

  private consumeDroppedPath(senderId: number, rawPath: unknown): string | null {
    if (typeof rawPath !== "string" || !rawPath) return null;
    const pending = this.pendingDrops.get(senderId);
    if (!pending) return null;
    const now = Date.now();
    for (const [path, expiresAt] of pending) {
      if (expiresAt <= now) pending.delete(path);
    }
    const path = resolve(rawPath);
    if (!pending.has(path)) {
      if (!pending.size) this.pendingDrops.delete(senderId);
      return null;
    }
    pending.delete(path);
    if (!pending.size) this.pendingDrops.delete(senderId);
    return path;
  }

  /**
   * The panel *window* a sender owns. Deliberately not routed through
   * `pluginIdForSender`: that also resolves docked views, and a docked view
   * asking for a window control must not reach the same plugin's separate
   * panel window.
   */
  private windowForSender(senderId: number): BrowserWindow | null {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && win.webContents.id === senderId) return win;
    }
    return null;
  }

  private applyWindowControl(
    window: BrowserWindow,
    action: PluginPanelWindowControlAction,
  ): void {
    switch (action) {
      case "getState":
        break;
      case "minimize":
        window.minimize();
        break;
      case "toggleMaximize":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "close":
        window.close();
        break;
    }
  }

  /**
   * Confine everything the panel's web contents can reach to the plugin's
   * declared domains. See `applyPluginEgressPolicy`, which the docked work-panel
   * view host shares.
   */
  private applyEgressPolicy(
    ses: Electron.Session,
    request: PluginPanelOpenRequest,
  ): void {
    applyPluginEgressPolicy(ses, {
      pluginId: request.pluginId,
      netDomains: request.netDomains,
      allowMicrophone: request.allowMicrophone,
      onBlockedRequest: this.onBlockedRequest,
    });
  }

  async open(request: PluginPanelOpenRequest): Promise<void> {
    const existing = this.windows.get(request.pluginId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }

    const partition = pluginSessionPartition(request.pluginId);
    const ses = session.fromPartition(partition, { cache: true });
    this.applyEgressPolicy(ses, request);

    const win = new BrowserWindow({
      width: Math.max(360, request.width || 480),
      height: Math.max(280, request.height || 360),
      title: request.title,
      show: false,
      autoHideMenuBar: true,
      // The host theme is only a fallback; the preload samples the actual
      // plugin page colors after it has loaded and paints the chrome from them.
      backgroundColor: request.theme === "light" ? "#ffffff" : "#181818",
      // Every platform uses the same frameless surface. The preload owns the
      // only visible window controls: a fixed three-button capsule.
      frame: false,
      webPreferences: {
        session: ses,
        preload: join(__dirname, "../preload/plugin-panel.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        additionalArguments: [
          `${PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX}${encodeURIComponent(request.locale)}`,
          `--pi-plugin-panel-theme=${request.theme}`,
          ...(request.development
            ? ["--pi-plugin-panel-development=1"]
            : []),
        ],
      },
    });
    // A panel owns its visible surface; do not add a native application menu
    // to the window around the plugin's own UI.
    win.setMenu(null);

    // A panel gets exactly one web contents. `window.open` would otherwise mint
    // a chromeless window outside the egress policy applied above.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const sendWindowState = () => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send(PLUGIN_PANEL_WINDOW_STATE_CHANNEL, {
        maximized: win.isMaximized(),
      });
    };
    win.on("maximize", sendWindowState);
    win.on("unmaximize", sendWindowState);
    win.webContents.on("did-finish-load", sendWindowState);

    // `closed` fires after the native window is gone. Copy the contents id
    // while the window is still alive; reading `webContents` later throws
    // "Object has been destroyed" and surfaces an uncaught main-process dialog.
    const webContentsId = win.webContents.id;
    win.on("closed", () => {
      this.pendingDrops.delete(webContentsId);
      this.windows.delete(request.pluginId);
    });

    this.windows.set(request.pluginId, win);
    await win.loadURL(pathToFileURL(request.htmlPath).toString());
    win.show();
  }

  async close(pluginId: string): Promise<void> {
    const win = this.windows.get(pluginId);
    if (!win || win.isDestroyed()) {
      this.windows.delete(pluginId);
      return;
    }
    win.close();
    this.windows.delete(pluginId);
  }

  async closeAll(): Promise<void> {
    for (const pluginId of [...this.windows.keys()]) {
      await this.close(pluginId);
    }
  }

  /**
   * Push a one-way event to every open plugin panel. The preload maps
   * `pluginBridge.on(event, handler)` to `pi-plugin-panel-event:<event>`, so
   * the host sends on that channel. Panels that do not subscribe are inert
   * receivers; the event names are fixed by the host (e.g. `appearance:changed`).
   */
  broadcast(event: string, payload: unknown): void {
    const channel = `pi-plugin-panel-event:${event}`;
    for (const win of this.windows.values()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}
