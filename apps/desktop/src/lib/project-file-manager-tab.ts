import type { SessionSummary } from "@pi-desktop/shared";
import type { AppState } from "../stores/app-state";
import { isRemoteSession } from "./remote-session-safety.ts";
import { normalizeProjectPath } from "./sidebar-session-groups.ts";
import { FILE_MANAGER_PLUGIN_TAB, hasPluginView, pluginWorkPanelTab, type WorkPanelContext, type WorkPanelTab } from "./work-panel-tabs.ts";

const entry = pluginWorkPanelTab(FILE_MANAGER_PLUGIN_TAB.pluginId, FILE_MANAGER_PLUGIN_TAB.viewId);
type Defaults = Pick<AppState, "fileManagerProjects" | "fileManagerTabReceipts">;

function projectKey(session?: SessionSummary) {
  return isRemoteSession(session) ? null : normalizeProjectPath(session?.projectPath);
}

/** Opening a view opts its project in; closing tabs never changes that decision. */
export function recordFileManagerOpen(state: AppState, sessionId: string, tab: WorkPanelTab): Partial<Defaults> {
  if (tab.id !== entry.id) return {};
  const key = projectKey(state.sessions.find((session) => session.id === sessionId));
  if (!key || state.fileManagerTabReceipts[sessionId] === key) return {};
  return {
    fileManagerProjects: state.fileManagerProjects.has(key) ? state.fileManagerProjects : new Set([...state.fileManagerProjects, key]),
    fileManagerTabReceipts: { ...state.fileManagerTabReceipts, [sessionId]: key },
  };
}

/** A session receives a plain entry once, never the originating file location. */
export function receiveFileManagerEntry(state: AppState, session: SessionSummary | undefined, context: WorkPanelContext) {
  const key = projectKey(session);
  if (!session || !key || !state.fileManagerProjects.has(key) || state.fileManagerTabReceipts[session.id] === key ||
      !hasPluginView(state.pluginViews, FILE_MANAGER_PLUGIN_TAB)) return null;
  return {
    context: context.tabs.some((tab) => tab.id === entry.id) ? context : {
      ...context, tabs: [...context.tabs, entry], activeTabId: context.activeTabId ?? entry.id,
    },
    receipts: { ...state.fileManagerTabReceipts, [session.id]: key },
  };
}
