import { useAppStore } from "../../stores/app-store";
import { captureLiveRendererDrafts } from "../../lib/renderer-refresh-capture";
import { HOME_DRAFT_KEY, pruneComposerDrafts, snapshotComposerDrafts, writeComposerDraft } from "../../lib/composer-draft-cache";
import { snapshotSubagentControlDrafts, restoreSubagentControlDrafts, pruneSubagentControlDrafts } from "../subagents/control-drafts";
import { emptyWorkPanelContext } from "../../lib/work-panel-tabs";
import { parseRendererRefreshCheckpoint, RENDERER_REFRESH_KEY, type RendererRefreshCheckpoint } from "./renderer-refresh-checkpoint";

let pending: RendererRefreshCheckpoint | undefined;
let restoring: Promise<void> | undefined;

/** No Host RPC, stop, or replay: checkpoint drafts first, then rebuild only the renderer. */
export function refreshRenderer(reload: () => void = () => window.location.reload()): void {
  captureLiveRendererDrafts();
  const state = useAppStore.getState();
  const contexts = { ...state.workPanelContexts };
  if (state.activeSessionId) contexts[state.activeSessionId] = {
    open: state.workPanelOpen, tabs: state.workPanelTabs, activeTabId: state.activeWorkPanelTabId,
    fileRequest: state.workPanelFileRequest,
  };
  const snapshot: RendererRefreshCheckpoint = {
    version: 1, page: state.page,
    ...(state.activeSessionId ? { sessionId: state.activeSessionId } : {}),
    composerDrafts: snapshotComposerDrafts(), subagentDrafts: snapshotSubagentControlDrafts(),
    panels: Object.entries(contexts).map(([sessionId, context]) => ({ sessionId, context })),
  };
  const raw = JSON.stringify(snapshot);
  parseRendererRefreshCheckpoint(raw);
  window.sessionStorage.setItem(RENDERER_REFRESH_KEY, raw);
  if (window.sessionStorage.getItem(RENDERER_REFRESH_KEY) !== raw) {
    throw new Error("Refresh checkpoint could not be verified");
  }
  reload();
}

/** A refused reload must not replay an old snapshot on an unrelated later reload. */
export function cancelRendererRefresh(): void {
  window.sessionStorage.removeItem(RENDERER_REFRESH_KEY);
}

/** Before first mount: editors see restored drafts rather than persisting blanks over them. */
export function restoreRendererRefreshDrafts(): void {
  try {
    const raw = window.sessionStorage.getItem(RENDERER_REFRESH_KEY);
    if (!raw) return;
    pending = parseRendererRefreshCheckpoint(raw);
    for (const { key, draft, workspacePath } of pending.composerDrafts) writeComposerDraft(key, draft, workspacePath);
    restoreSubagentControlDrafts(pending.subagentDrafts);
  } catch (error) {
    pending = undefined;
    console.warn("Renderer refresh checkpoint could not be restored", error instanceof Error ? error.name : "UnknownError");
    try { window.sessionStorage.removeItem(RENDERER_REFRESH_KEY); }
    catch { console.warn("Renderer refresh checkpoint storage is unavailable"); }
  }
}

/** Bootstrap owns session truth. Restore presentation only after it has completed. */
export function restoreRendererRefreshView(): Promise<void> {
  if (restoring) return restoring;
  if (!pending) return Promise.resolve();
  const snapshot = pending;
  pending = undefined;
  restoring = (async () => {
    const before = useAppStore.getState();
    const valid = new Set(before.sessions.map((session) => session.id));
    pruneComposerDrafts([HOME_DRAFT_KEY, ...valid]);
    pruneSubagentControlDrafts(valid);
    const target = snapshot.sessionId && valid.has(snapshot.sessionId) ? snapshot.sessionId : undefined;
    if (target && before.activeSessionId !== target) await before.selectSession(target, { record: false });
    const current = useAppStore.getState();
    if (current.navStack !== before.navStack || current.navIndex !== before.navIndex) return;
    if (target && current.activeSessionId !== target) return;
    if (!target && current.activeSessionId !== before.activeSessionId) return;
    const liveIds = new Set(current.sessions.map((session) => session.id));
    const contexts = Object.fromEntries(snapshot.panels.filter((panel) => liveIds.has(panel.sessionId))
      .map(({ sessionId, context }) => [sessionId, context]));
    const visible = target ? contexts[target] ?? emptyWorkPanelContext() : emptyWorkPanelContext();
    useAppStore.setState({ workPanelContexts: contexts,
      workPanelOpen: visible.open, workPanelTabs: visible.tabs, activeWorkPanelTabId: visible.activeTabId,
      workPanelFileRequest: visible.fileRequest });
    current.setPage(snapshot.page, { record: false });
  })().finally(() => {
    window.sessionStorage.removeItem(RENDERER_REFRESH_KEY);
    restoring = undefined;
  });
  return restoring;
}
