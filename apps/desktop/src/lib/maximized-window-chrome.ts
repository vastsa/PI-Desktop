type WindowChromeApi = {
  windowControl(action: "getState" | "toggleMaximize"): Promise<{ maximized: boolean }>;
  onWindowMaximized(listener: (state: { maximized: boolean }) => void): () => void;
};

/** Disable macOS caption dragging without disabling native zoom or green controls. */
export function installMaximizedWindowChrome(
  platform: string,
  document: Document,
  view: Pick<Window, "getComputedStyle">,
  api: WindowChromeApi,
): () => void {
  if (platform !== "darwin") return () => {};
  let disposed = false;
  let revision = 0;
  let maximized = false;
  let pending = false;
  const root = document.documentElement;
  const previous = root.dataset.windowMaximized;
  const apply = (state: { maximized: boolean }) => {
    maximized = state.maximized;
    root.dataset.windowMaximized = String(maximized);
  };
  const unsubscribe = api.onWindowMaximized((state) => {
    revision += 1;
    if (!disposed) apply(state);
  });
  void api.windowControl("getState").then((state) => {
    if (!disposed && revision === 0) apply(state);
  }).catch((error: unknown) => console.error("window chrome state query failed", error));

  const doubleClick = (event: MouseEvent) => {
    if (!maximized || pending || event.defaultPrevented || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    // The marker inherits through caption text but explicit no-drag controls
    // reset it, matching the native draggable-region exclusions.
    if (view.getComputedStyle(event.target).getPropertyValue("--window-drag-region").trim() !== "drag") return;
    event.preventDefault();
    pending = true;
    const expectedRevision = revision;
    void api.windowControl("toggleMaximize").then((state) => {
      if (!disposed && revision === expectedRevision) apply(state);
    }).catch((error: unknown) => console.error("window chrome restore failed", error))
      .finally(() => { pending = false; });
  };
  document.addEventListener("dblclick", doubleClick);
  return () => {
    disposed = true;
    unsubscribe();
    document.removeEventListener("dblclick", doubleClick);
    if (previous === undefined) delete root.dataset.windowMaximized;
    else root.dataset.windowMaximized = previous;
  };
}
