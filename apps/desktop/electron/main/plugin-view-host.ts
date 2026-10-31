import {
  session,
  shell,
  WebContentsView,
  type BrowserWindow,
  type WebContents,
} from "electron";
import { join } from "node:path";
import { getModuleDirectory } from "./module-path";
import { parseAllowedExternalUrl } from "./safe-open-external";
import { PanelSenders, pageGoneWithin } from "./plugin-panel-senders";
import {
  PLUGIN_VIEW_LOCATION_EVENT,
  PLUGIN_VIEW_LOCATION_PARAM,
  normalizeLocation,
  planLocationDelivery,
  viewEntryUrl,
} from "./plugin-view-location";
import {
  scaleBoundsToDip,
  type PluginViewBounds,
} from "./plugin-view-bounds";
import { normalizePluginViewScale, pluginViewZoom } from "./plugin-view-scale";
import {
  applyPluginEgressPolicy,
  pluginSessionPartition,
  type PluginPanelBlockedRequest,
} from "./plugin-panel-host";
import {
  PLUGIN_PANEL_EMBEDDED_ARGUMENT,
  PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX,
  type PluginPanelTheme,
} from "../shared/plugin-panel-chrome";

/**
 * Re-exported so the location contract stays addressable through the module
 * that owns the view lifecycle. The rules themselves live in
 * `plugin-view-location.ts`, free of Electron, so they stay unit-testable.
 */
export { PLUGIN_VIEW_LOCATION_EVENT, PLUGIN_VIEW_LOCATION_PARAM, viewEntryUrl };

/**
 * Plugin-contributed work panel views (ADR 0104).
 *
 * A view is the same isolated web page as a `ui.panel` window — sandboxed
 * preload, per-plugin persisted partition, `net.domains` egress allowlist — but
 * composited inside the main window at a rect the renderer measures, exactly as
 * `BrowserPane` does for the preview browser. The renderer stays the visibility
 * authority: a `WebContentsView` always draws above renderer content, so it
 * must be hidden whenever the view is not the active panel surface or a
 * blocking overlay is open.
 *
 * Views are cached rather than destroyed on tab switch so a plugin keeps its
 * scroll position and in-page state, bounded by `MAX_LIVE_VIEWS` so a user who
 * browses many plugins does not accumulate renderer processes forever.
 */

/** Live views kept warm; the least recently shown one is evicted past this. */
const MAX_LIVE_VIEWS = 4;

export type PluginViewOpenRequest = {
  pluginId: string;
  viewId: string;
  locale: string;
  theme: PluginPanelTheme;
  /** Absolute path to the view's HTML entry. */
  htmlPath: string;
  /** Egress allowlist from `manifest.net.domains`. */
  netDomains?: readonly string[];
  /** The install-time `net.anyHost` grant, passed through to the egress policy. */
  netAnyHost?: boolean;
  /**
   * What this view should show, when the opener knows (D320 follow-up).
   *
   * A work-panel view is opened either from the tool launcher, which has no
   * specific subject, from a chat file reference, which does, or by a plan or
   * goal approval artifact, whose host-chosen view receives the artifact path
   * (D452). The value is
   * opaque to the host: it travels as the entry URL's `piViewOpen` query
   * parameter on creation and as the `view:open` event afterwards, and the
   * plugin decides what it means. `pi.browser` uses its own chrome channel
   * instead and never receives this.
   */
  location?: string;
};

export type { PluginViewBounds };

type LiveView = {
  key: string;
  pluginId: string;
  view: WebContentsView;
  /** Absolute path to this view's HTML entry; its URL is rebuilt from it. */
  htmlPath: string;
  /** Monotonic counter; lowest value is the least recently shown. */
  usedAt: number;
  /**
   * What this view should show, or null when nothing specific was requested.
   * The page reads it from its own URL, so this is also the value a later
   * request is re-delivered against.
   */
  location: string | null;
  /** False until the first document finished loading. */
  loaded: boolean;
};

export function pluginViewKey(pluginId: string, viewId: string): string {
  return `${pluginId}/${viewId}`;
}

export class PluginViewHost {
  private views = new Map<string, LiveView>();
  private window: BrowserWindow | null = null;
  /** The one view currently attached to the window, if any. */
  private visibleKey: string | null = null;
  private bounds: PluginViewBounds = { x: 0, y: 0, width: 0, height: 0 };
  /** Last CSS-pixel rect from the renderer, so zoom changes can rescale. */
  private lastCssBounds: PluginViewBounds | null = null;
  private clock = 0;
  /**
   * Appearance → Font size multiplier the app is painting at (D343). A docked
   * view repeats it as page zoom; see `plugin-view-scale.ts`.
   */
  private fontScale = 1;
  /** Factor already pushed to the live pages, so a resize does not re-push it. */
  private appliedZoom: number | null = null;
  private onBlockedRequest?: PluginPanelBlockedRequest;
  /**
   * Identity of the pages allowed to use the bridge, keyed by web contents. A
   * view keeps its plugin for as long as its page exists, not only while it is
   * cached in `views`, so a call that arrives while the view is being dropped
   * still belongs to its own plugin.
   */
  private senders = new PanelSenders();

  constructor(onBlockedRequest?: PluginPanelBlockedRequest) {
    this.onBlockedRequest = onBlockedRequest;
  }

  /**
   * Fired when the visible plugin view changes. The work-panel browser guest
   * clamps itself to this rect so it cannot cover chat/composer.
   */
  onSurface?: (
    surface: {
      pluginId: string;
      viewId: string;
      visible: boolean;
      bounds: PluginViewBounds;
      /**
       * Zoom the visible page is painting at. A chrome page that reports its
       * guest hole in its own CSS pixels (`pi.browser`) needs this to convert
       * back to DIP once the host applied the app's type scale.
       */
      scale: number;
    } | null,
  ) => void;

  /**
   * Push a one-way event to every live docked view. Detached panel windows
   * are broadcast separately by `PluginPanelHost`; both surfaces share the
   * preload channel `pi-plugin-panel-event:<event>`.
   */
  broadcast(event: string, payload: unknown, filter?: (pluginId: string) => boolean): void {
    const channel = `pi-plugin-panel-event:${event}`;
    for (const entry of this.views.values()) {
      if (filter && !filter(entry.pluginId)) continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      try {
        wc.send(channel, payload);
      } catch {
        // One view that cannot receive must not starve the others.
      }
    }
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    this.detachVisible();
    this.unbindZoom();
    this.window = window;
    this.bindZoom();
  }

  private zoomListener: (() => void) | null = null;

  private bindZoom(): void {
    const contents = this.window && !this.window.isDestroyed() ? this.window.webContents : null;
    if (!contents || contents.isDestroyed()) return;
    const onChange = () => {
      if (this.lastCssBounds) {
        this.bounds = scaleBoundsToDip(this.lastCssBounds, this.currentZoomFactor());
      }
      const visible = this.visibleKey ? this.views.get(this.visibleKey) : null;
      visible?.view.setBounds(this.bounds);
      // The window zoom is part of the docked page zoom, so the pages follow it
      // and the surface carries the new factor behind the browser guest rect.
      this.resyncZoom();
    };
    try {
      contents.on("zoom-changed", onChange);
    } catch {
      // Older Electron may not emit zoom-changed; resize remeasures.
    }
    this.zoomListener = () => {
      try {
        contents.removeListener("zoom-changed", onChange);
      } catch {
        // contents already destroyed
      }
    };
  }

  private unbindZoom(): void {
    this.zoomListener?.();
    this.zoomListener = null;
  }

  /** Whether a live web contents exists for this view. */
  has(pluginId: string, viewId: string): boolean {
    return this.views.has(pluginViewKey(pluginId, viewId));
  }

  /**
   * The plugin owning a web contents, so `PluginPanelHost` can accept bridge
   * calls from docked views on the same channel it serves panel windows.
   */
  pluginIdForSender(senderId: number): string | null {
    return this.senders.pluginFor(senderId);
  }

  /**
   * Create the view if needed and mark it as the most recently used. Nothing is
   * attached here: the renderer follows with `setBounds` / `setVisible` once it
   * has measured the panel surface.
   *
   * Re-opening an already live view re-delivers its location — a second click
   * on the same chat reference is a request to show that file, not a cache
   * hit — and never tears the view down, so unsaved work inside a plugin is
   * not discarded by navigation.
   */
  open(request: PluginViewOpenRequest): void {
    const key = pluginViewKey(request.pluginId, request.viewId);
    const location = normalizeLocation(request.location);
    const existing = this.views.get(key);
    if (existing) {
      existing.usedAt = ++this.clock;
      this.deliverLocation(existing, location);
      return;
    }
    const view = this.createView(request);
    const entry: LiveView = {
      key,
      pluginId: request.pluginId,
      view,
      htmlPath: request.htmlPath,
      usedAt: ++this.clock,
      location,
      loaded: false,
    };
    this.views.set(key, entry);
    // A docked view can call the bridge from its first script, so its identity is
    // registered before the document loads and released only when the page is
    // gone — never when the host merely drops the cached surface around it.
    const senderId = view.webContents.id;
    this.senders.register(senderId, request.pluginId);
    view.webContents.once("destroyed", () => this.senders.release(senderId));
    view.webContents.once("did-finish-load", () => {
      entry.loaded = true;
    });
    this.load(entry);
    this.evictBeyondLimit();
  }

  /**
   * Hand a view the subject it should show.
   *
   * A document that has not finished loading cannot have subscribed to the
   * event yet, so the location is written into its URL and the load restarted;
   * nothing has run, so nothing is lost. Once loaded, the view subscribes and
   * is told through the same preload event channel as every other panel event.
   */
  private deliverLocation(entry: LiveView, location: string | null): void {
    const delivery = planLocationDelivery(entry.location, location, entry.loaded);
    if (delivery.kind === "none") return;
    // The page reads its subject from the URL it was loaded with, so the
    // remembered value has to follow every accepted request.
    entry.location = delivery.location;
    if (delivery.kind === "reload") {
      this.load(entry);
      return;
    }
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    wc.send(`pi-plugin-panel-event:${PLUGIN_VIEW_LOCATION_EVENT}`, {
      path: delivery.location,
    });
  }

  private load(entry: LiveView): void {
    void entry.view.webContents
      .loadURL(viewEntryUrl(entry.htmlPath, entry.location))
      .catch(() => {
        // Load failures surface to the user as the tab's empty state; the view
        // stays cached so a plugin reload can retry into the same slot.
      });
  }

  setBounds(bounds: PluginViewBounds): void {
    // Renderer measures CSS pixels; WebContentsView.setBounds wants DIPs.
    this.lastCssBounds = {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width) || 0,
      height: Number(bounds.height) || 0,
    };
    this.bounds = scaleBoundsToDip(this.lastCssBounds, this.currentZoomFactor());
    const visible = this.visibleKey ? this.views.get(this.visibleKey) : null;
    visible?.view.setBounds(this.bounds);
    this.syncZoom();
    this.emitSurface();
  }

  /**
   * Follow the app's Appearance type scale (D343). A docked view is its own web
   * page, so `--font-scale` on the app document cannot reach it; the host
   * repeats the same factor as that page's zoom. Live views are rescaled in
   * place, so neither plugin state nor scroll position is lost.
   */
  setFontScale(scale: number): void {
    const next = normalizePluginViewScale(scale);
    if (next === this.fontScale) return;
    this.fontScale = next;
    this.resyncZoom();
  }

  /**
   * Re-assert the composed zoom after the window's own zoom changed. Menu Zoom
   * In / Out / Reset scale the app page only, so without this the docked pages
   * would keep the old factor and drift out of proportion with the app.
   */
  resyncZoom(): void {
    this.applyZoomToAll(this.viewZoom());
    if (this.visibleKey) this.emitSurface();
  }

  private currentZoomFactor(): number {
    const contents = this.window && !this.window.isDestroyed() ? this.window.webContents : null;
    if (!contents || contents.isDestroyed()) return 1;
    const zoom = Number(contents.getZoomFactor());
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }

  /** Zoom every docked page paints at: the app type scale times window zoom. */
  private viewZoom(): number {
    return pluginViewZoom(this.fontScale, this.currentZoomFactor());
  }

  /**
   * Re-apply the factor only when it drifted. The renderer re-measures a zoomed
   * window by reporting bounds again, so this is the path that catches a zoom
   * whose `zoom-changed` never arrived (menu zoom, restored window) without
   * poking every page on each resize frame.
   */
  private syncZoom(): void {
    const zoom = this.viewZoom();
    if (zoom === this.appliedZoom) return;
    this.applyZoomToAll(zoom);
  }

  private applyZoomToAll(zoom: number): void {
    this.appliedZoom = zoom;
    for (const entry of this.views.values()) {
      this.applyZoom(entry.view.webContents, zoom);
    }
  }

  private applyZoom(wc: WebContents, zoom: number): void {
    if (wc.isDestroyed()) return;
    try {
      wc.setZoomFactor(zoom);
    } catch {
      // A page being torn down rejects the change; its next load re-applies it.
    }
  }

  /**
   * Show exactly one view, or none.
   *
   * Only one work panel surface is on screen at a time, so showing a view
   * implicitly detaches whichever was attached before. That keeps a stale view
   * from lingering above the renderer when the user switches tabs quickly.
   */
  setVisible(pluginId: string, viewId: string, visible: boolean): void {
    const key = pluginViewKey(pluginId, viewId);
    if (!visible) {
      if (this.visibleKey === key) this.detachVisible();
      return;
    }
    const entry = this.views.get(key);
    if (!entry) return;
    if (this.visibleKey && this.visibleKey !== key) this.detachVisible();
    entry.usedAt = ++this.clock;
    if (!this.window || this.window.isDestroyed()) return;
    const children = this.window.contentView.children;
    if (!children.includes(entry.view)) {
      this.window.contentView.addChildView(entry.view);
    }
    entry.view.setBounds(this.bounds);
    this.visibleKey = key;
    this.emitSurface();
  }

  close(pluginId: string, viewId: string): void {
    this.destroy(pluginViewKey(pluginId, viewId));
  }

  /** Drop every view a plugin owns — disable, uninstall, reload, or crash. */
  closePlugin(pluginId: string): void {
    for (const [key, entry] of [...this.views]) {
      if (entry.pluginId === pluginId) this.destroy(key);
    }
  }

  /**
   * Drop every view and wait, bounded, for the pages to be gone, so a caller
   * that is about to stop the plugin runtime knows no view page can still call
   * it. Shutdown sequences this before that stop.
   */
  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.views.values()].map(async (entry) => {
        // Captured while the view is alive; `destroy` closes the page below.
        const page = entry.view.webContents;
        this.destroy(entry.key);
        await pageGoneWithin(page);
      }),
    );
  }

  private destroy(key: string): void {
    const entry = this.views.get(key);
    if (!entry) return;
    if (this.visibleKey === key) this.detachVisible();
    this.views.delete(key);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  /**
   * Detach the on-screen view without closing its page (renderer reload path).
   *
   * A renderer reload drops the React tree that owns plugin-view visibility.
   * The native view would keep compositing above the fresh renderer as an
   * orphan layer nothing can hide or close — its owning tab is gone and the
   * new tree starts with an empty panel. Main therefore detaches on every
   * main-frame navigation; the reloaded renderer re-attaches a view through
   * the normal open/setVisible path when the user opens the tab again.
   */
  hideVisibleView(): void {
    this.detachVisible();
  }

  private detachVisible(): void {
    const entry = this.visibleKey ? this.views.get(this.visibleKey) : null;
    this.visibleKey = null;
    if (entry && this.window && !this.window.isDestroyed()) {
      const children = this.window.contentView.children;
      if (children.includes(entry.view)) {
        this.window.contentView.removeChildView(entry.view);
      }
    }
    this.emitSurface();
  }

  private emitSurface(): void {
    if (!this.onSurface) return;
    if (!this.visibleKey) {
      this.onSurface(null);
      return;
    }
    const separator = this.visibleKey.indexOf("/");
    if (separator <= 0) {
      this.onSurface(null);
      return;
    }
    this.onSurface({
      pluginId: this.visibleKey.slice(0, separator),
      viewId: this.visibleKey.slice(separator + 1),
      visible: true,
      bounds: this.bounds,
      scale: this.viewZoom(),
    });
  }

  /** Evict least-recently-shown views, never the one currently on screen. */
  private evictBeyondLimit(): void {
    while (this.views.size > MAX_LIVE_VIEWS) {
      const candidates = [...this.views.values()]
        .filter((entry) => entry.key !== this.visibleKey)
        .sort((a, b) => a.usedAt - b.usedAt);
      const oldest = candidates[0];
      if (!oldest) return;
      this.destroy(oldest.key);
    }
  }

  private createView(request: PluginViewOpenRequest): WebContentsView {
    const ses = session.fromPartition(pluginSessionPartition(request.pluginId), {
      cache: true,
    });
    applyPluginEgressPolicy(ses, {
      pluginId: request.pluginId,
      netDomains: request.netDomains,
      netAnyHost: request.netAnyHost,
      onBlockedRequest: this.onBlockedRequest,
    });

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: join(
          getModuleDirectory(import.meta.url),
          "../preload/plugin-panel.js",
        ),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        additionalArguments: [
          `${PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX}${encodeURIComponent(request.locale)}`,
          `--pi-plugin-panel-theme=${request.theme}`,
          PLUGIN_PANEL_EMBEDDED_ARGUMENT,
        ],
      },
    });
    const wc = view.webContents;
    // A docked view gets exactly one web contents. `window.open` would mint a
    // chromeless window outside the egress policy applied above.
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) void shell.openExternal(allowed);
      return { action: "deny" };
    });
    // A page renders at 100% until the host can touch it, so set the factor now
    // and again on each fresh document: the first paint is already sized.
    this.applyZoom(wc, this.viewZoom());
    wc.on("dom-ready", () => this.applyZoom(wc, this.viewZoom()));
    return view;
  }
}
