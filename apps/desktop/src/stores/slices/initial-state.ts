import type { AppState, AppStateData } from "../app-state";
import { projectWorkspaceFromPath } from "../../lib/sidebar-preferences";
import { loadSidebarPreferences } from "../../lib/sidebar-preferences";
import { loadWorkPanelWidth } from "./work-panel-slice";

export const initialSidebarPreferences = loadSidebarPreferences();
export const initialWorkPanelWidth = loadWorkPanelWidth();

function withProjectDisplayName(
  workspace: NonNullable<AppState["workspace"]>,
  projectMeta: AppState["projectMeta"],
): NonNullable<AppState["workspace"]> {
  const name = projectMeta[workspace.path]?.name;
  return name ? { ...workspace, name } : workspace;
}

/** Values that are stable before the first host bootstrap response arrives. */
export function createInitialState(): AppStateData {
  return {
    ready: false,
    healthOk: false,
    sessions: [],
    sessionMeta: initialSidebarPreferences.sessionMeta,
    sessionView: {
      ...initialSidebarPreferences.sessionView,
      sortBy: initialSidebarPreferences.sessionView.sort,
      showArchived: initialSidebarPreferences.sessionView.archived,
    },
    openProjects: initialSidebarPreferences.openProjectPaths.map((path) =>
      withProjectDisplayName(
        projectWorkspaceFromPath(path),
        initialSidebarPreferences.projectMeta,
      ),
    ),
    openProjectPaths: initialSidebarPreferences.openProjectPaths,
    createProjectDialogOpen: false,
    activeProjectPath: undefined,
    projectMeta: initialSidebarPreferences.projectMeta,
    projectCollapsed: Object.fromEntries(
      Object.entries(initialSidebarPreferences.projectMeta)
        .filter(([, meta]) => meta.collapsed === true)
        .map(([path]) => [path, true]),
    ),
    subagentPanel: null,
    workPanelOpen: false,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelContexts: {},
    workPanelWidth: initialWorkPanelWidth,
    workPanelFileRequest: null,
    projectSort: initialSidebarPreferences.projectSort,
    messages: [],
    retainedSessionIds: [],
    retainedTranscripts: {},
    sessionHistory: {},
    draftConfiguration: null,
    isRunning: false,
    runningSessions: {},
    agentStatuses: {},
    latestTurnResults: {},
    sessionOutcomes: {},
    sessionCompactions: {},
    providers: [],
    providerModels: {},
    plugins: [],
    pluginThemes: [],
    pluginViews: [],
    pendingPermissions: {},
    pendingAsks: {},
    queuedPrompts: {},
    planningStates: {},
    pendingPlans: {},
    planCheckpoints: {},
    page: "chat",
    settingsTab: "general",
    settingsAnchor: null,
    navStack: [{ page: "chat" }],
    navIndex: 0,
    toasts: [],
    notifications: [],
    unreadNotificationCount: 0,
    composerPrefill: null,
    error: null,
    errorCode: null,
    errorRetriable: null,
  };
}
