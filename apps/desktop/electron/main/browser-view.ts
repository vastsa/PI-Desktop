import { shell, WebContentsView, type BrowserWindow } from "electron";
import { statSync, watch, type FSWatcher } from "node:fs";
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
  const resolvedRoot = resolve(root);
  return path === resolvedRoot || path.startsWith(resolvedRoot + sep);
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
    if (!statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
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

  constructor(onState: (state: BrowserState) => void) {
    this.onState = onState;
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
      url: wc.getURL(),
      title: wc.getTitle(),
      isLoading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  getWebContents() {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  navigate(raw: string, fileRoot: string | null = null): BrowserState | null {
    if (fileRoot) this.fileRoot = fileRoot;
    const localPath = resolveLocalFile(raw, this.fileRoot);
    if (localPath) {
      const view = this.ensureView();
      this.watchDirForReload(dirname(localPath));
      void view.webContents.loadURL(pathToFileURL(localPath).toString()).catch(() => {
        // Navigation failures surface through did-fail-load → state push.
      });
      if (this.visible) this.attach();
      return this.getState();
    }
    const url = normalizeUrl(raw);
    if (!url) return this.getState();
    this.clearLiveReload();
    const view = this.ensureView();
    void view.webContents.loadURL(url).catch(() => {
      // Navigation failures surface through did-fail-load → state push.
    });
    if (this.visible) this.attach();
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
    if (!target) return this.getState();
    if (localPath) this.watchDirForReload(dirname(localPath));
    else this.clearLiveReload();
    const view = this.ensureView();
    if (this.visible) this.attach();
    try {
      await Promise.race([
        view.webContents.loadURL(target),
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(1, timeoutMs));
        }),
      ]);
    } catch {
      // Load failures surface through did-fail-load → state push.
    }
    return this.getState();
  }

  action(action: "back" | "forward" | "reload" | "stop"): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (action === "back" && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    } else if (action === "forward" && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    } else if (action === "reload") {
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
        partition: PARTITION,
      },
    });
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) void shell.openExternal(allowed);
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedHttpUrl(url)) return;
      // Relative links inside a previewed page may point at sibling files;
      // anything escaping the workspace root stays blocked.
      if (/^file:/i.test(url) && this.isAllowedFileUrl(url)) return;
      event.preventDefault();
    });
    wc.on("did-navigate", (_event, url) => {
      if (!/^file:/i.test(url)) return;
      try {
        this.watchDirForReload(dirname(fileURLToPath(url)));
      } catch {
        // Non-path file URL — keep the previous watcher.
      }
    });
    const push = () => {
      const state = this.getState();
      if (state) this.onState(state);
    };
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    wc.on("did-navigate", push);
    wc.on("did-navigate-in-page", push);
    wc.on("page-title-updated", push);
    wc.on("did-fail-load", push);
    this.view = view;
    return view;
  }
}
