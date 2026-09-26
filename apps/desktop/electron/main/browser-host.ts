import type { BrowserWindow } from "electron";
import type { BrowserState } from "@pi-desktop/shared";
import type { BrowserPane } from "./browser-view";
import { BrowserCdp } from "./browser-cdp";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const BROWSER_PLUGIN_ID = "pi.browser";
export const BROWSER_VIEW_ID = "browser";

export type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserNavigateInput = {
  url?: string;
  path?: string;
};

/**
 * Translate a plugin-page hole into window coordinates and clamp it so the
 * guest cannot cover chat/composer outside the calling plugin view.
 */
export function clampGuestBounds(
  view: BrowserRect,
  hole: BrowserRect,
): BrowserRect | null {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width,
    height,
  };
}

function asRect(value: unknown): BrowserRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

export type BrowserHostDeps = {
  createPane: (onState: (state: BrowserState) => void, onOpenUrl: (url: string) => void) => BrowserPane;
  onOpenUrl?: (url: string, sessionId?: string) => void;
  isPluginLoaded: (pluginId: string) => boolean;
  getFileRoot: (sessionId?: string) => Promise<string | null>;
  getScratchDir?: (sessionId?: string) => string | null;
  onState: (state: BrowserState) => void;
};

type ChromeSurface = {
  pluginId: string;
  viewId: string;
  visible: boolean;
  bounds: BrowserRect;
};

type BrowserPage = {
  key: string;
  sessionId: string;
  tabId: string | null;
  pane: BrowserPane;
  cdp: BrowserCdp;
  state: BrowserState | null;
  started: boolean;
  navigationVersion: number;
  navigating: boolean;
};

/** Host-owned pages, keyed by conversation and resource tab. */
export class BrowserHost {
  private readonly deps: BrowserHostDeps;
  private readonly pages = new Map<string, BrowserPage>();
  private readonly locations = new Map<string, string>();
  private readonly selectedTabs = new Map<string, string | null>();
  private readonly pendingSessions = new Map<string, string>();
  private readonly pendingTabs = new Set<string>();
  private active: BrowserPage | null = null;
  private window: BrowserWindow | null = null;
  private chrome: ChromeSurface | null = null;
  private hole: BrowserRect | null = null;
  private holePluginId: string | null = null;

  constructor(deps: BrowserHostDeps) { this.deps = deps; }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (!window) { this.disposeGuest(); return; }
    for (const page of this.pages.values()) page.pane.setWindow(window);
    this.applyGuest();
  }

  setChromeSurface(surface: ChromeSurface | null): void {
    this.chrome = surface;
    this.applyGuest();
  }

  getContext(): { sessionId?: string; tabId?: string } {
    return this.active ? this.contextFor(this.active) : {};
  }

  private contextFor(page: BrowserPage): { sessionId?: string; tabId?: string } {
    return {
      ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      ...(page.tabId ? { tabId: page.tabId } : {}),
    };
  }

  private key(sessionId: string, tabId: string | null): string {
    return JSON.stringify([sessionId, tabId]);
  }

  private pageFor(sessionId: string, tabId: string | null): BrowserPage {
    const key = this.key(sessionId, tabId);
    const existing = this.pages.get(key);
    if (existing) return existing;
    const page: BrowserPage = {
      key, sessionId, tabId, cdp: new BrowserCdp(), state: null,
      started: false, navigationVersion: 0, navigating: false,
      pane: this.deps.createPane(
        (state) => {
          if (this.pages.get(key) !== page) return;
          page.state = state;
          if (state.url && !page.navigating && !this.pendingTabs.has(key)) this.locations.set(key, state.url);
          if (this.active === page) this.publishCurrent();
        },
        (url) => {
          if (this.pages.get(key) === page) this.deps.onOpenUrl?.(url, sessionId || undefined);
        },
      ),
    };
    page.pane.setWindow(this.window);
    this.pages.set(key, page);
    return page;
  }

  private publishCurrent(): void {
    const state = this.getState();
    this.deps.onState(state ?? {
      url: "", title: "", isLoading: false, canGoBack: false, canGoForward: false,
      ...this.getContext(),
    });
  }

  setChromeSession(sessionId: string | undefined, tabId?: string, location?: string): boolean {
    const id = sessionId?.trim() || "";
    const tab = tabId ?? (this.active?.sessionId === id
      ? this.active.tabId : this.selectedTabs.get(id) ?? null);
    const page = this.pageFor(id, tab);
    if (this.active === page) return false;
    this.active?.pane.setVisible(false);
    this.active = page;
    this.selectedTabs.set(id, tab);
    const pending = this.pendingSessions.get(id);
    if (pending) {
      this.locations.set(page.key, pending);
      this.pendingTabs.add(page.key);
      this.pendingSessions.delete(id);
    }
    const target = this.locations.get(page.key) ?? location?.trim();
    const navigate = this.pendingTabs.delete(page.key) || (!page.started && !page.navigating);
    if (target && navigate) {
      page.started = false;
      page.state = null;
      this.publishCurrent();
      this.applyGuest();
      void this.navigatePage(page, target).catch((error) => {
        console.warn("Browser tab restore failed", error);
      });
    } else {
      this.publishCurrent();
      this.applyGuest();
    }
    return true;
  }

  setGuestHole(pluginId: string, hole: unknown): BrowserRect | null {
    this.hole = asRect(hole);
    this.holePluginId = pluginId;
    this.applyGuest();
    return this.guestBounds();
  }

  setGuestVisible(pluginId: string, visible: boolean): void {
    if (!visible && this.holePluginId === pluginId) {
      this.active?.pane.setVisible(false);
    } else if (visible) {
      this.applyGuest();
    }
  }

  rememberLocation(sessionId: string | undefined, location: string): void {
    const id = sessionId?.trim();
    const target = location.trim();
    if (!id || !target) return;
    const tabId = this.selectedTabs.get(id);
    if (tabId != null) {
      const key = this.key(id, tabId);
      this.locations.set(key, target);
      if (this.active?.key !== key) this.pendingTabs.add(key);
    } else {
      this.pendingSessions.set(id, target);
    }
  }

  async navigate(input: BrowserNavigateInput, sessionId?: string, tabId?: string): Promise<BrowserState | null> {
    const target = String(input.path ?? input.url ?? "").trim();
    if (!target) return this.getState();
    const id = sessionId?.trim() || this.active?.sessionId || "";
    if (tabId !== undefined) {
      const page = this.pages.get(this.key(id, tabId));
      return page ? this.navigatePage(page, target) : null;
    }
    if (!this.active) {
      this.active = this.pageFor(id, this.selectedTabs.get(id) ?? null);
      this.selectedTabs.set(id, this.active.tabId);
    }
    if (id !== this.active.sessionId) {
      this.rememberLocation(id, target);
      return null;
    }
    return this.navigatePage(this.active, target);
  }

  private async navigatePage(page: BrowserPage, target: string): Promise<BrowserState | null> {
    const version = ++page.navigationVersion;
    page.navigating = true;
    this.locations.set(page.key, target);
    const current = () => this.pages.get(page.key) === page && page.navigationVersion === version;
    let state: BrowserState | null;
    try {
      const root = await this.deps.getFileRoot(page.sessionId || undefined);
      if (!current()) return null;
      state = await page.pane.navigateAndWait(target, root);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
      return null;
    }
    if (!current()) return null;
    page.navigating = false;
    page.started = state !== null;
    page.state = state ?? page.pane.getState();
    if (!this.pendingTabs.has(page.key)) this.locations.set(page.key, state?.url || target);
    if (!state && !page.state?.loadError) {
      page.state = { url: target, title: "", isLoading: false,
        canGoBack: false, canGoForward: false, loadError: "INVALID_URL" };
    }
    if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
    return state ? { ...state, ...this.contextFor(page) } : null;
  }

  action(action: "back" | "forward" | "reload" | "stop", sessionId?: string, tabId?: string): void {
    const page = sessionId !== undefined && tabId !== undefined
      ? this.pages.get(this.key(sessionId, tabId)) : this.active;
    if (page?.state) page.pane.action(action);
  }

  getState(): BrowserState | null {
    return this.active?.state ? { ...this.active.state, ...this.getContext() } : null;
  }

  openExternal(sessionId?: string, tabId?: string): void {
    const page = sessionId !== undefined && tabId !== undefined
      ? this.pages.get(this.key(sessionId, tabId)) : this.active;
    if (page?.started) page.pane.openExternal();
  }

  private currentPage(): BrowserPage {
    if (!this.active?.started) throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
    return this.active;
  }

  private requireWebContents() {
    const wc = this.currentPage().pane.getWebContents();
    if (!wc || wc.isDestroyed()) throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
    return wc;
  }

  async snapshot(): Promise<{ tree: string; url: string; title: string }> {
    return this.currentPage().cdp.snapshot(this.requireWebContents());
  }

  async screenshot(input: { fullPage?: boolean } = {}, sessionId?: string): Promise<{ mimeType: string; data: string; path?: string }> {
    const page = this.currentPage();
    const shot = await page.cdp.screenshot(this.requireWebContents(), input);
    const scratch = this.deps.getScratchDir?.(sessionId ?? page.sessionId);
    if (!scratch) return shot;
    try {
      mkdirSync(scratch, { recursive: true });
      const path = join(scratch, `browser-screenshot-${Date.now()}.jpg`);
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      return { ...shot, path };
    } catch { return shot; }
  }

  async click(uid: string): Promise<void> { await this.currentPage().cdp.click(this.requireWebContents(), uid); }
  async fill(uid: string, text: string): Promise<void> { await this.currentPage().cdp.fill(this.requireWebContents(), uid, text); }
  async evaluate(expression: string): Promise<unknown> { return this.currentPage().cdp.evaluate(this.requireWebContents(), expression); }
  console(limit?: number): { messages: ReturnType<BrowserCdp["console"]> } {
    if (!this.active?.started) return { messages: [] };
    const wc = this.requireWebContents();
    void this.active.cdp.attach(wc);
    return { messages: this.active.cdp.console(limit) };
  }
  async cdpCommand(method: string, params?: unknown): Promise<unknown> { return this.currentPage().cdp.send(this.requireWebContents(), method, params); }

  /** The renderer-created resource tab is the preview's only navigation owner. */
  async previewWorkspaceFile(_sessionId: string, _path: string, _root: string): Promise<{ ok: true } | { ok: false; content: string }> {
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) return {
      ok: false, content: "BrowserPreview: the Browser plugin is disabled. Enable pi.browser in Plugins to preview HTML.",
    };
    return { ok: true };
  }

  closeTab(sessionId: string, tabId: string | null): void {
    const key = this.key(sessionId, tabId);
    const page = this.pages.get(key);
    if (page) {
      this.pages.delete(key);
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
      if (this.active === page) this.active = null;
    }
    this.locations.delete(key);
    this.pendingTabs.delete(key);
    if (this.selectedTabs.get(sessionId) === tabId) this.selectedTabs.delete(sessionId);
  }

  closeSession(sessionId: string): void {
    for (const page of [...this.pages.values()]) {
      if (page.sessionId !== sessionId) continue;
      this.closeTab(sessionId, page.tabId);
    }
    this.pendingSessions.delete(sessionId);
    this.selectedTabs.delete(sessionId);
    for (const key of this.locations.keys()) {
      if (JSON.parse(key)[0] === sessionId) { this.locations.delete(key); this.pendingTabs.delete(key); }
    }
  }

  dispose(): void { this.disposeGuest(); }

  disposeGuest(): void {
    for (const page of this.pages.values()) {
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
    }
    this.pages.clear();
    this.active = null;
    this.hole = null;
    this.holePluginId = null;
  }

  private guestBounds(): BrowserRect | null {
    if (!this.chrome?.visible || !this.hole || this.holePluginId !== this.chrome.pluginId) return null;
    return clampGuestBounds(this.chrome.bounds, this.hole);
  }

  private applyGuest(): void {
    if (!this.active) return;
    const bounds = this.guestBounds();
    if (!bounds || !this.active.started) { this.active.pane.setVisible(false); return; }
    this.active.pane.setBounds(bounds);
    this.active.pane.setVisible(true);
  }
}
