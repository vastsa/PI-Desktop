import { BrowserWindow, ipcMain, Menu, session, systemPreferences } from "electron";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { isNetUrlAllowed, THEME_ASSET_SCHEME } from "@pi-desktop/plugin-sdk";
import { builtinWindowBackground } from "@pi-desktop/shared";
import { suppressLinuxFramelessSystemMenu } from "./frameless-system-menu";
import { PanelSenders, pageGoneWithin, resolvePanelInvocation } from "./plugin-panel-senders";
import {
  isPluginPanelWindowControlAction,
  PLUGIN_PANEL_MIN_SIZE,
  PLUGIN_PANEL_WIDGET_MIN_SIZE,
  PLUGIN_PANEL_WIDGET_ARGUMENT,
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
   * `"panel"` (default) keeps the 46px host drag band and its three-control
   * capsule. `"widget"` opens the same sandboxed page as a transparent floating
   * surface with neither, so a plugin can be a small orb the user keeps on
   * screen. The plugin surface itself is unchanged: same preload bridge, same
   * partition, same egress policy.
   */
  shape?: "panel" | "widget";
  /** Floating widget placement only: keep the surface above other windows. */
  alwaysOnTop?: boolean;
  /** Overrides the per-shape default: panels are resizable, widgets are not. */
  resizable?: boolean;
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

/**
 * Schemes a panel may always load: its own bundle, devtools plumbing, and the
 * host scheme that serves declared theme assets. The asset handler resolves
 * through the requested plugin's own declarations, so admitting it here does
 * not widen egress — it is read-only and package-scoped (ADR 0248).
 */
const PANEL_LOCAL_SCHEMES = new Set([
  "file:",
  "data:",
  "blob:",
  "devtools:",
  "chrome-extension:",
  `${THEME_ASSET_SCHEME}:`,
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
  ses.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    if (permission !== "media" || input.allowMicrophone !== true) return false;
    // Chromium probes with "unknown" (or an empty mediaType) before the
    // request. Denying that fails getUserMedia even when the following
    // request is audio-only.
    return details.mediaType !== "video";
  });

}

/** macOS TCC: a sandboxed file:// panel often never prompts on its own. */
async function ensureOsMicrophone(allowMicrophone?: boolean): Promise<void> {
  if (!allowMicrophone || process.platform !== "darwin") return;
  try {
    if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return;
    await systemPreferences.askForMediaAccess("microphone");
  } catch {
    // Headless tests have no TCC surface.
  }
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
  /**
   * Locale per floating-widget web contents. Presence in this map is also what
   * makes a window a widget for `showWidgetMenu`, so a panel never gets a
   * context menu it did not ask for.
   */
  private widgetLocales = new Map<number, string>();
  /**
   * Identity of the panel pages allowed to use the bridge, keyed by web
   * contents. A page belongs to its plugin for as long as it exists, not only
   * while `windows` still lists its surface as open, so a call that arrives
   * while the host is closing that surface is still the panel's own call.
   */
  private senders = new PanelSenders();

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
        const invocation = resolvePanelInvocation(
          this.pluginIdForSender(event.sender.id),
          event.sender.isDestroyed(),
        );
        if (invocation.kind === "foreign") throw new Error("invalid panel invoker");
        // A page that is already gone can never read the answer: the call is the
        // tail of the teardown that closed its surface. Settle it rather than
        // dispatching into a plugin runtime that may already be stopping.
        if (invocation.kind === "gone") return;
        const pluginId = invocation.pluginId;
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
        if (!window) {
          // The capsule asks for `getState` on install and for `close` while the
          // surface tears down; a page that is already gone cannot read either
          // answer, so it is settled rather than reported as an invalid invoker.
          if (event.sender.isDestroyed()) return;
          throw new Error("invalid panel window control invoker");
        }
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

  /**
   * The plugin a bridge call belongs to. Panel identity comes from `senders`,
   * which outlives the host's record of open windows; the resolvers cover the
   * docked work-panel views owned by `PluginViewHost`.
   */
  private pluginIdForSender(senderId: number): string | null {
    const own = this.senders.pluginFor(senderId);
    if (own) return own;
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
      case "contextMenu":
        this.showWidgetMenu(window);
        break;
      case "close":
        window.close();
        break;
    }
  }

  /**
   * A floating widget has no capsule, so its own context menu opens the host's
   * window menu instead. Without it the only way out of a widget would be a
   * plugin-authored close button, and a plugin that never added one would leave
   * a window the user cannot dismiss.
   *
   * Only a widget is registered in `widgetLocales`; a panel or docked view that
   * asks for this action gets nothing, because panels keep the capsule.
   */
  private showWidgetMenu(window: BrowserWindow): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const locale = this.widgetLocales.get(window.webContents.id);
    if (locale === undefined) return;
    const labels = catalogs[resolveLocale(locale)].pluginPanelWidget;
    const menu = Menu.buildFromTemplate([
      {
        label: labels.alwaysOnTop,
        type: "checkbox",
        checked: window.isAlwaysOnTop(),
        click: (item) => {
          if (!window.isDestroyed()) window.setAlwaysOnTop(item.checked);
        },
      },
      { type: "separator" },
      {
        label: labels.minimize,
        click: () => {
          if (!window.isDestroyed()) window.minimize();
        },
      },
      {
        label: labels.close,
        click: () => {
          if (!window.isDestroyed()) window.close();
        },
      },
    ]);
    menu.popup({ window });
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
      this.applyEgressPolicy(existing.webContents.session, request);
      await ensureOsMicrophone(request.allowMicrophone);
      // The microphone prompt is asynchronous: the panel can be closed while the
      // user answers it, and a destroyed window has no `show`. Fall through and
      // build the requested panel instead of reusing a window that is gone.
      if (!existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return;
      }
    }

    const partition = pluginSessionPartition(request.pluginId);
    const ses = session.fromPartition(partition, { cache: true });
    this.applyEgressPolicy(ses, request);
    await ensureOsMicrophone(request.allowMicrophone);


    const widget = request.shape === "widget";
    const minSize = widget ? PLUGIN_PANEL_WIDGET_MIN_SIZE : PLUGIN_PANEL_MIN_SIZE;
    const win = new BrowserWindow({
      width: Math.max(minSize.width, request.width || (widget ? 220 : 480)),
      height: Math.max(minSize.height, request.height || (widget ? 220 : 360)),
      title: request.title,
      show: false,
      autoHideMenuBar: true,
      // The host theme is only a fallback; the preload samples the actual
      // plugin page colors after it has loaded and paints the chrome from them.
      backgroundColor: widget ? "#00000000" : builtinWindowBackground(request.theme),
      // Every platform uses the same frameless surface. A panel's visible window
      // controls are the preload's three-button capsule; a floating widget has
      // no chrome of its own — the plugin draws its silhouette edge to edge.
      frame: false,
      transparent: widget,
      // A transparent window would otherwise carry a rectangular native shadow
      // around an orb that is round; a widget draws its own glow instead.
      hasShadow: !widget,
      resizable: request.resizable ?? !widget,
      alwaysOnTop: widget && request.alwaysOnTop === true,
      // A floating widget is a desktop companion, not a taskbar entry, and it
      // has no capsule to restore from a maximized state.
      skipTaskbar: widget,
      maximizable: !widget,
      ...(widget ? { fullscreenable: false } : {}),
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
          ...(widget ? [PLUGIN_PANEL_WIDGET_ARGUMENT] : []),
          ...(request.development
            ? ["--pi-plugin-panel-development=1"]
            : []),
        ],
      },
    });
    // A panel owns its visible surface; do not add a native application menu
    // to the window around the plugin's own UI.
    win.setMenu(null);
    suppressLinuxFramelessSystemMenu(win);

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
    if (widget) this.widgetLocales.set(webContentsId, request.locale);
    win.on("closed", () => {
      this.pendingDrops.delete(webContentsId);
      this.widgetLocales.delete(webContentsId);
      this.senders.release(webContentsId);
      // Only when this window is still the registered one: a page that closes
      // slowly can already have been replaced by a newer panel window for the
      // plugin, and that newer entry has to survive the predecessor's teardown.
      if (this.windows.get(request.pluginId) === win) {
        this.windows.delete(request.pluginId);
      }
    });

    this.windows.set(request.pluginId, win);
    // The page can call the bridge from its first script, so its identity is
    // registered before the document loads and released only when the page is
    // gone (see the `closed` handler above).
    this.senders.register(webContentsId, request.pluginId);
    await win.loadURL(pathToFileURL(request.htmlPath).toString());
    win.show();
  }

  /**
   * Close the plugin's panel and resolve once its page is gone. Bounded, for two
   * reasons: the page may still be finishing, and its bridge calls have to reach
   * a live plugin runtime while it does; and a page that refuses to close
   * (`beforeunload`) must settle the call at the budget instead of holding it
   * forever. A refused close leaves the panel registered: it is still open.
   */
  async close(pluginId: string): Promise<void> {
    const win = this.windows.get(pluginId);
    if (!win || win.isDestroyed()) {
      this.windows.delete(pluginId);
      return;
    }
    // Captured while the window is alive; the close destroys its web contents,
    // and the `closed` handler above owns the removal from `windows`.
    const page = win.webContents;
    win.close();
    await pageGoneWithin(page);
  }

  /**
   * Close every panel and wait for every one of those pages to be gone, so a
   * caller can stop the plugin runtime and the host afterwards. Shutdown relies
   * on that order: a call a closing page already sent is otherwise answered by a
   * runtime that is already shutting down, and is reported as a bridge failure
   * nobody can act on.
   */
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.windows.keys()].map((pluginId) => this.close(pluginId)),
    );
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
      try {
        win.webContents.send(channel, payload);
      } catch {
        // One panel that cannot receive must not starve the others.
      }
    }
  }
}
