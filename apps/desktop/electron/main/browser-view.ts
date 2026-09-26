import { shell, WebContentsView, type BrowserWindow } from "electron";
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserState } from "@pi-desktop/shared";
import { isAllowedHttpUrl, parseAllowedExternalUrl } from "./safe-open-external";

/**
 * Work panel embedded preview browser (D100, ADR 0019).
 *
 * A single WebContentsView owned by the main process, attached to the main
 * window and positioned from renderer-measured bounds. The renderer is the
 * visibility authority: it hides the view whenever the browser tab is not
 * the active panel surface or a blocking overlay opens (the view always
 * composites above renderer content).
 *
 * Besides http(s) URLs, the pane renders HTML files inside the workspace
 * (agent-generated pages) with live reload: the loaded file's directory is
 * watched so edits to the page or its sibling assets refresh the preview.
 */

const PARTITION = "persist:work-browser";
const LIVE_RELOAD_DEBOUNCE_MS = 250;

export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isWithinRoot(path: string, root: string): boolean {
  try {
    const realRoot = realpathSync(resolve(root));
    const realPath = realpathSync(resolve(path));
    return realPath === realRoot || realPath.startsWith(realRoot + sep);
  } catch {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);
  }
}

/**
 * Resolve user input to a previewable file inside the workspace: a file://
 * URL, an absolute path, or a workspace-relative path (./demo/index.html,
 * index.html). Returns null unless the target exists as a file within the
 * root — inputs like "localhost:3000/a.html" then fall through to URL
 * handling instead of a broken file load.
 */
export function resolveLocalFile(raw: string, root: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !root) return null;
  let candidate: string | null = null;
  if (/^file:/i.test(trimmed)) {
    try {
      candidate = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  } else if (isAbsolute(trimmed)) {
    candidate = trimmed;
  } else if (/^\.{1,2}\//.test(trimmed) || /\.[a-zA-Z0-9]+$/.test(trimmed)) {
    candidate = resolve(root, trimmed);
  }
  if (!candidate) return null;
  const resolved = resolve(candidate);
  if (!isWithinRoot(resolved, root)) return null;
  try {
    const real = realpathSync(resolved);
    const realRoot = realpathSync(resolve(root));
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

export class BrowserPane {
  private view: WebContentsView | null = null;
  private window: BrowserWindow | null = null;
  private visible = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private onState: (state: BrowserState) => void;
  private fileRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private navigationEpoch = 0;
  private stateEventsEpoch: number | null = null;
  private stateUrl: string | null = null;
  private nativeNavigationPending = false;
  private pendingTarget: string | null = null;
  private loadError: { url: string; message: string } | null = null;
  private cancelPending: (() => void) | null = null;

  private readonly onOpenUrl?: (url: string) => void;

  constructor(onState: (state: BrowserState) => void, onOpenUrl?: (url: string) => void) {
    this.onState = onState;
    this.onOpenUrl = onOpenUrl;
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    this.detach();
    this.window = window;
  }

  getState(): BrowserState | null {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return {
      url: this.loadError?.url ?? this.pendingTarget ?? wc.getURL(),
      title: wc.getTitle(),
      isLoading: !this.loadError && (this.pendingTarget !== null || wc.isLoading()),
      ...(this.loadError ? { loadError: this.loadError.message } : {}),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  getWebContents() {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  /**
   * Stop native WebContents events from publishing state for the document
   * that belonged to the previous session. The next completed managed
   * navigation establishes a new event scope.
   */
  invalidateNavigation(): void {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    this.navigationEpoch += 1;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
  }

  navigate(raw: string, fileRoot: string | null = null): BrowserState | null {
    void this.navigateAndWait(raw, fileRoot);
    return this.getState();
  }

  async navigateAndWait(
    raw: string,
    fileRoot: string | null = null,
    timeoutMs = 15_000,
  ): Promise<BrowserState | null> {
    if (fileRoot) this.fileRoot = fileRoot;
    const localPath = resolveLocalFile(raw, this.fileRoot);
    const target = localPath
      ? pathToFileURL(localPath).toString()
      : normalizeUrl(raw);
    if (!target) {
      this.beginManagedNavigation();
      this.loadError = { url: raw, message: "INVALID_URL" };
      const state = this.getState();
      if (state) this.onState(state);
      return null;
    }
    const epoch = this.beginManagedNavigation();
    this.pendingTarget = target;
    this.loadError = null;
    if (localPath) this.watchDirForReload(dirname(localPath));
    else this.clearLiveReload();
    const view = this.ensureView();
    const wc = view.webContents;
    const loading = this.getState();
    if (loading) this.onState(loading);
    if (this.visible) this.attach();
    return new Promise<BrowserState | null>((resolve) => {
      let settled = false;
      let started = false;
      const destinations = new Set([target]);
      const finish = (committed: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener("did-start-navigation", onStart);
        wc.removeListener("did-navigate", onCommit);
        wc.removeListener("did-redirect-navigation", onRedirect);
        wc.removeListener("did-fail-load", onFailure);
        if (epoch !== this.navigationEpoch) { resolve(null); return; }
        this.cancelPending = null;
        this.pendingTarget = null;
        if (error) this.loadError = { url: target, message: error };
        const state = this.getState();
        if (committed && state) this.enableStateEvents(epoch, state.url);
        if (error && state) this.onState(state);
        resolve(committed ? state : null);
      };
      const onStart = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace && url === target) started = true;
      };
      const onRedirect = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (started && mainFrame && !inPlace && epoch === this.navigationEpoch) destinations.add(url);
      };
      const onFailure = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => {
        if (mainFrame !== false && code !== -3 && destinations.has(url)) finish(false, description);
      };
      const onCommit = (_event: unknown, url: string) => {
        // A current main-frame commit is ready to display even if images or
        // subframes are still loading. Old-session events cannot satisfy it.
        if (started && epoch === this.navigationEpoch && destinations.has(url) && url === wc.getURL()) finish(true);
      };
      const timer = setTimeout(() => finish(false, "ERR_TIMED_OUT"), Math.max(1, timeoutMs));
      this.cancelPending = () => finish(false);
      wc.on("did-start-navigation", onStart);
      wc.on("did-navigate", onCommit);
      wc.on("did-redirect-navigation", onRedirect);
      wc.on("did-fail-load", onFailure);
      void wc.loadURL(target).then(
        () => { if (destinations.has(wc.getURL())) finish(true); },
        (error: unknown) => finish(false, error instanceof Error ? error.message : String(error)),
      );
    });
  }

  action(action: "back" | "forward" | "reload" | "stop"): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (action === "stop" && this.pendingTarget) {
      const url = this.pendingTarget;
      this.cancelPending?.();
      this.loadError = { url, message: "ERR_ABORTED" };
      wc.stop();
      const state = this.getState();
      if (state) this.onState(state);
      return;
    }
    if (action === "back" && wc.navigationHistory.canGoBack()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goBack();
    } else if (action === "forward" && wc.navigationHistory.canGoForward()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goForward();
    } else if (action === "reload") {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.reload();
    } else if (action === "stop") {
      wc.stop();
    }
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    const safe = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    this.bounds = safe;
    if (this.view && this.visible) this.view.setBounds(safe);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.view) return;
    this.view.setVisible?.(visible);
    if (visible) this.attach();
    else this.detach();
  }

  openExternal(): void {
    const url = this.view?.webContents.getURL();
    if (!url) return;
    const allowed = parseAllowedExternalUrl(url);
    if (allowed) {
      void shell.openExternal(allowed);
      return;
    }
    if (this.isAllowedFileUrl(url)) {
      try {
        void shell.openPath(fileURLToPath(url));
      } catch {
        // Invalid file URL — leave the preview in place.
      }
    }
  }

  dispose(): void {
    this.invalidateNavigation();
    this.clearLiveReload();
    this.detach();
    if (this.view) {
      this.view.webContents.close();
      this.view = null;
    }
  }

  private attach(): void {
    if (!this.window || this.window.isDestroyed() || !this.view) return;
    const children = this.window.contentView.children;
    // The guest hole sits on top of plugin chrome. Re-adding a plugin view
    // after this pane is attached would cover the guest unless we keep it last.
    if (children.includes(this.view) && children[children.length - 1] !== this.view) {
      this.window.contentView.removeChildView(this.view);
    }
    if (!this.window.contentView.children.includes(this.view)) {
      this.window.contentView.addChildView(this.view);
    }
    this.view.setBounds(this.bounds);
  }

  private detach(): void {
    if (!this.window || this.window.isDestroyed() || !this.view) return;
    const children = this.window.contentView.children;
    if (children.includes(this.view)) {
      this.window.contentView.removeChildView(this.view);
    }
  }

  /** Watch the previewed file's directory so page + asset edits re-render. */
  private watchDirForReload(dir: string): void {
    if (this.watcher && this.watchedDir === dir) return;
    this.clearLiveReload();
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.scheduleReload());
      this.watchedDir = dir;
    } catch {
      this.watcher = null;
      this.watchedDir = null;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      const wc = this.view?.webContents;
      if (wc && !wc.isDestroyed() && wc.getURL().startsWith("file:")) {
        wc.reloadIgnoringCache();
      }
    }, LIVE_RELOAD_DEBOUNCE_MS);
  }

  private clearLiveReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.watchedDir = null;
  }

  private isAllowedFileUrl(url: string): boolean {
    if (!this.fileRoot) return false;
    try {
      return isWithinRoot(resolve(fileURLToPath(url)), this.fileRoot);
    } catch {
      return false;
    }
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
        partition: PARTITION,
      },
    });
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) {
        if (this.onOpenUrl) this.onOpenUrl(allowed);
        else void shell.openExternal(allowed);
      }
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedHttpUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      // Relative links inside a previewed page may point at sibling files;
      // anything escaping the workspace root stays blocked.
      if (/^file:/i.test(url) && this.isAllowedFileUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      event.preventDefault();
    });
    wc.on("did-navigate", (_event, url) => {
      if (!this.acceptNativeNavigation(url)) return;
      if (!/^file:/i.test(url)) return;
      try {
        this.watchDirForReload(dirname(fileURLToPath(url)));
      } catch {
        // Non-path file URL — keep the previous watcher.
      }
    });
    const push = () => {
      if (!this.hasCurrentStateEventScope()) return;
      const url = wc.getURL();
      if (this.stateUrl !== url) return;
      const state = this.getState();
      if (state) this.onState(state);
    };
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    wc.on("did-navigate", (_event, url) => {
      if (this.acceptNativeNavigation(url)) push();
    });
    wc.on("did-navigate-in-page", (_event, url, isMainFrame, processId, routingId) => {
      // Same-document navigation has no will-navigate event. Accept only the
      // active main frame's current URL, without reopening invalidated sessions.
      if (
        !isMainFrame ||
        !this.hasCurrentStateEventScope() ||
        url !== wc.getURL() ||
        processId !== wc.mainFrame.processId ||
        routingId !== wc.mainFrame.routingId
      ) return;
      this.enableStateEvents(this.navigationEpoch, url);
      push();
    });
    wc.on("page-title-updated", push);
    wc.on(
      "did-fail-load",
      (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
        // Replacing a still-loading document aborts its old request. That
        // event must not consume the pending navigation to the new document.
        if (isMainFrame === false || _errorCode === -3) return;
        if (this.acceptNativeNavigation(validatedUrl)) push();
      },
    );
    this.view = view;
    return view;
  }

  private beginManagedNavigation(): number {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    const epoch = ++this.navigationEpoch;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
    return epoch;
  }

  private enableStateEvents(epoch: number, url: string): void {
    if (epoch !== this.navigationEpoch) return;
    this.stateEventsEpoch = epoch;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
  }

  private hasCurrentStateEventScope(): boolean {
    return this.stateEventsEpoch === this.navigationEpoch && this.stateUrl !== null;
  }

  private acceptNativeNavigation(url: string): boolean {
    if (!this.hasCurrentStateEventScope()) return false;
    if (url === this.stateUrl) {
      this.nativeNavigationPending = false;
      return true;
    }
    if (!this.nativeNavigationPending) return false;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
    return true;
  }
}
