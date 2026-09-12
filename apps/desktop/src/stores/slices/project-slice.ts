import i18n from "i18next";
import type {
  ProjectWorkspace,
  SessionSummary,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import {
  rememberProject,
  renameRecentProject,
  setProjectPinned,
} from "../../lib/recent-projects";
import {
  clearSessionPanes,
  releaseSessionPane,
} from "../../lib/session-panes";
import {
  clearSessionAsks,
} from "../../lib/pending-asks";
import {
  clearSessionPermissions,
} from "../../lib/pending-permissions";
import {
  projectIsArchived,
  projectIsCollapsed,
  projectIsPinned,
  sessionIsArchived,
  sessionIsPinned,
  sortProjects,
  sortSessions,
  normalizeProjectName,
  type ProjectMeta,
  type ProjectSort,
  type SessionMeta,
  type SessionSort,
} from "../../lib/sidebar-preferences";
import {
  normalizeProjectPath,
  sessionMatchesProject,
} from "../../lib/sidebar-session-groups";
import type { AppState } from "../app-state";
import type { SessionRuntime } from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

export type ProjectSliceDependencies = StoreAccess & {
  runtime: SessionRuntime;
  manualSessionTitles: Set<string>;
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
  withProjectDisplayName: (
    workspace: ProjectWorkspace,
    projectMeta: Record<string, ProjectMeta>,
  ) => ProjectWorkspace;
  promoteProjectPath: (paths: string[], path: string) => string[];
  removeProjectPath: (paths: string[], path: string) => string[];
  upsertWorkspace: (
    projects: ProjectWorkspace[],
    workspace: ProjectWorkspace,
  ) => ProjectWorkspace[];
  persistCurrentSidebar: (getState: () => AppState) => void;
};

export function createProjectSlice({
  get,
  set,
  runtime,
  manualSessionTitles,
  withoutRecordKey,
  withProjectDisplayName,
  promoteProjectPath,
  removeProjectPath,
  upsertWorkspace,
  persistCurrentSidebar,
}: ProjectSliceDependencies): Pick<
  AppState,
  | "activateProject"
  | "refreshProject"
  | "openProjectPath"
  | "switchProjectPath"
  | "closeProjectPath"
  | "closeProject"
  | "cloneProject"
  | "openProject"
  | "closeProjectDialog"
  | "createProjectFromFolders"
  | "clearProject"
  | "toggleSessionPinned"
  | "toggleSessionArchived"
  | "archiveSession"
  | "restoreSession"
  | "renameSession"
  | "moveSessionProject"
  | "deleteSession"
  | "setSessionSort"
  | "setSessionArchiveVisibility"
  | "setSessionView"
  | "setShowArchived"
  | "archiveProject"
  | "toggleProjectPinned"
  | "renameProject"
  | "toggleProjectArchived"
  | "restoreProject"
  | "setProjectCollapsed"
  | "toggleProjectCollapsed"
  | "setProjectSort"
  | "reorderProjects"
  | "getVisibleSessions"
  | "getSortedProjects"
> {
  return {
    activateProject: async (path, opts) => {
      const intent = opts?.navigationIntent ?? runtime.beginNavigationIntent();
      const preserveConversation = runtime.isSessionSelectionForIntent(intent);
      const requestedPath = path.trim();
      if (!requestedPath) return null;
      const result = await api.setProject(requestedPath);
      if (!runtime.navigationIntentIsCurrent(intent)) return null;
      const workspace = result.workspace
        ? withProjectDisplayName(result.workspace, get().projectMeta)
        : null;
      if (!workspace?.path) return null;
      if (
        normalizeProjectPath(get().activeProjectPath) !==
          normalizeProjectPath(workspace.path) &&
        !preserveConversation
      ) {
        get().resetWorkPanelContext();
      }

      set((state) => {
        const switchesVisibleProject =
          normalizeProjectPath(state.activeProjectPath) !==
          normalizeProjectPath(workspace.path);
        const openProjectPaths = promoteProjectPath(
          state.openProjectPaths,
          workspace.path,
        );
        const openProjects = upsertWorkspace(state.openProjects, workspace);
        return {
          workspace,
          activeProjectPath: workspace.path,
          openProjectPaths,
          openProjects,
          page: "chat" as const,
          ...(switchesVisibleProject && !preserveConversation
            ? {
                ...clearSessionPanes(),
                activeSessionId: undefined,
                messages: [],
                isRunning: false,
              }
            : {}),
        };
      });
      rememberProject({
        path: workspace.path,
        name: workspace.name || workspace.path,
        branch: workspace.branch,
      });
      persistCurrentSidebar(get);
      return workspace;
    },

    refreshProject: async (path) => {
      const requestedKey = normalizeProjectPath(path);
      if (!requestedKey) return null;

      const result = await api.getProject();
      const workspace = result.workspace
        ? withProjectDisplayName(result.workspace, get().projectMeta)
        : null;
      if (
        !workspace?.path ||
        normalizeProjectPath(workspace.path) !== requestedKey
      ) {
        return null;
      }

      let applied = false;
      set((state) => {
        if (normalizeProjectPath(state.activeProjectPath) !== requestedKey) {
          return state;
        }
        applied = true;
        return {
          workspace,
          openProjects: upsertWorkspace(state.openProjects, workspace),
        };
      });
      return applied ? workspace : null;
    },

    openProjectPath: async (path) => get().activateProject(path),
    switchProjectPath: async (path) => get().activateProject(path),

    closeProjectPath: async (path) => {
      const intent = runtime.beginNavigationIntent();
      const key = normalizeProjectPath(path);
      if (!key) return;
      const state = get();
      const isActive = normalizeProjectPath(state.activeProjectPath) === key;
      const nextPaths = removeProjectPath(state.openProjectPaths, path);
      if (isActive) {
        const fallbackPath = nextPaths[nextPaths.length - 1];
        if (fallbackPath) {
          await get().activateProject(fallbackPath, { navigationIntent: intent });
        } else {
          await get().clearProject({ navigationIntent: intent });
        }
        if (!runtime.navigationIntentIsCurrent(intent)) return;
      }
      set((current) => ({
        openProjectPaths: removeProjectPath(current.openProjectPaths, path),
        openProjects: current.openProjects.filter(
          (project) => normalizeProjectPath(project.path) !== key,
        ),
      }));
      persistCurrentSidebar(get);
    },
    closeProject: async (path) => get().closeProjectPath(path),

    cloneProject: async (url) => {
      const intent = runtime.beginNavigationIntent();
      const result = await api.cloneProject(url);
      if (!runtime.navigationIntentIsCurrent(intent)) return null;
      if (result.canceled || !result.workspace?.path) return null;
      return get().activateProject(result.workspace.path, {
        navigationIntent: intent,
      });
    },

    openProject: async () => {
      set({ createProjectDialogOpen: true });
    },
    closeProjectDialog: () => {
      set({ createProjectDialogOpen: false });
    },
    createProjectFromFolders: async ({ name, folders, primaryPath }) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        throw new Error(i18n.t("errors.projectNameLength"));
      }
      const uniqueFolders = folders.filter(
        (path, index, all) =>
          Boolean(normalizeProjectPath(path)) &&
          all.findIndex(
            (candidate) => normalizeProjectPath(candidate) === normalizeProjectPath(path),
          ) === index,
      );
      if (uniqueFolders.length === 0) {
        throw new Error(i18n.t("project.createFolderRequired"));
      }
      const normalizedPrimary = normalizeProjectPath(primaryPath);
      const primary =
        uniqueFolders.find((path) => normalizeProjectPath(path) === normalizedPrimary) ??
        uniqueFolders[0];
      const orderedFolders = [
        primary,
        ...uniqueFolders.filter(
          (path) => normalizeProjectPath(path) !== normalizeProjectPath(primary),
        ),
      ];
      const intent = runtime.beginNavigationIntent();
      for (const path of orderedFolders) {
        await get().activateProject(path, { navigationIntent: intent });
        if (!runtime.navigationIntentIsCurrent(intent)) return;
      }
      get().renameProject(primary, normalizedName);
      if (
        normalizeProjectPath(get().activeProjectPath) !==
        normalizeProjectPath(primary)
      ) {
        await get().activateProject(primary, { navigationIntent: intent });
      }
      const onboarding = await api.getOnboarding();
      if (!runtime.navigationIntentIsCurrent(intent)) return;
      set({ createProjectDialogOpen: false, onboarding, page: "chat" });
    },

    clearProject: async (opts) => {
      const intent = opts?.navigationIntent ?? runtime.beginNavigationIntent();
      const preserveConversation = runtime.isSessionSelectionForIntent(intent);
      await api.clearProject();
      if (!runtime.navigationIntentIsCurrent(intent)) return;
      if (!preserveConversation) get().resetWorkPanelContext();
      set({
        workspace: null,
        activeProjectPath: undefined,
        ...(preserveConversation
          ? {}
          : {
              ...clearSessionPanes(),
              activeSessionId: undefined,
              messages: [],
              isRunning: false,
            }),
      });
      persistCurrentSidebar(get);
      const onboarding = await api.getOnboarding();
      if (!runtime.navigationIntentIsCurrent(intent)) return;
      set({ onboarding });
    },

    toggleSessionPinned: (id) => {
      if (!id) return;
      set((state) => {
        const pinned = !sessionIsPinned(id, state.sessionMeta);
        const sessionMeta = {
          ...state.sessionMeta,
          [id]: { ...(state.sessionMeta[id] || {}), pinned },
        };
        const sessions = state.sessions.map((session) =>
          session.id === id ? { ...session, pinned } : session,
        );
        return { sessionMeta, sessions };
      });
      persistCurrentSidebar(get);
    },

    toggleSessionArchived: (id) => {
      if (!id) return;
      set((state) => {
        const archived = !sessionIsArchived(id, state.sessionMeta);
        const sessionMeta = {
          ...state.sessionMeta,
          [id]: { ...(state.sessionMeta[id] || {}), archived },
        };
        const sessions = state.sessions.map((session) =>
          session.id === id ? { ...session, archived } : session,
        );
        return { sessionMeta, sessions };
      });
      persistCurrentSidebar(get);
    },

    archiveSession: (id) => {
      if (!id) return;
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          [id]: { ...(state.sessionMeta[id] || {}), archived: true },
        },
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, archived: true } : session,
        ),
      }));
      persistCurrentSidebar(get);
    },

    restoreSession: (id) => {
      if (!id) return;
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          [id]: { ...(state.sessionMeta[id] || {}), archived: false },
        },
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, archived: false } : session,
        ),
      }));
      persistCurrentSidebar(get);
    },

    renameSession: async (id, title) => {
      if (!id) return;
      const nextTitle = title.trim();
      if (!nextTitle) throw new Error(i18n.t("errors.sessionTitleEmpty"));
      manualSessionTitles.add(id);
      const result = await api.renameSession(id, nextTitle);
      if (!result.ok) throw new Error(i18n.t("errors.sessionNotFound"));
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          [id]: { ...(state.sessionMeta[id] || {}), manualTitle: true },
        },
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, title: nextTitle } : session,
        ),
      }));
      persistCurrentSidebar(get);
    },

    moveSessionProject: async (id, projectPath) => {
      const destinationKey = normalizeProjectPath(projectPath);
      const state = get();
      const session = state.sessions.find((item) => item.id === id);
      if (!id || !session || !destinationKey) return false;
      if (state.runningSessions[id]) return false;
      if (normalizeProjectPath(session.projectPath) === destinationKey) return true;
      if (
        !state.openProjectPaths.some(
          (path) => normalizeProjectPath(path) === destinationKey,
        )
      ) {
        return false;
      }
      const result = await api.moveSessionProject(id, projectPath);
      set((current) => ({
        sessions: current.sessions.map((item) =>
          item.id === id ? { ...item, ...result.session } : item,
        ),
      }));
      return true;
    },

    deleteSession: async (id) => {
      if (!id) return;
      await api.deleteSession(id);
      manualSessionTitles.delete(id);
      runtime.pendingSessionConfigurations.delete(id);
      runtime.sessionTranscriptCache.delete(id);
      runtime.sessionHistoryCache.delete(id);
      runtime.liveSessionTranscripts.delete(id);
      runtime.sessionOlderLoads.delete(id);
      if (get().activeSessionId === id) get().resetWorkPanelContext();
      set((state) => {
        const sessionMeta = { ...state.sessionMeta };
        delete sessionMeta[id];
        const sessions = state.sessions.filter((session) => session.id !== id);
        const runningSessions = { ...state.runningSessions };
        delete runningSessions[id];
        const agentStatuses = { ...state.agentStatuses };
        delete agentStatuses[id];
        const sessionOutcomes = { ...state.sessionOutcomes };
        delete sessionOutcomes[id];
        const queuedPrompts = withoutRecordKey(state.queuedPrompts, id);
        const workPanelContexts = withoutRecordKey(state.workPanelContexts, id);
        const pendingPermissions = clearSessionPermissions(
          state.pendingPermissions,
          id,
        );
        const pendingAsks = clearSessionAsks(state.pendingAsks, id);
        const latestTurnResults = withoutRecordKey(state.latestTurnResults, id);
        const planningStates = withoutRecordKey(state.planningStates, id);
        const pendingPlans = withoutRecordKey(state.pendingPlans, id);
        const planCheckpoints = withoutRecordKey(state.planCheckpoints, id);
        const sessionCompactions = withoutRecordKey(state.sessionCompactions, id);
        const sessionHistory = withoutRecordKey(state.sessionHistory, id);
        const retainedNav = state.navStack.filter(
          (entry) => entry.sessionId !== id,
        );
        const navStack =
          retainedNav.length > 0 ? retainedNav : [{ page: "chat" as const }];
        return {
          ...releaseSessionPane(state, id),
          sessionMeta,
          sessions,
          runningSessions,
          agentStatuses,
          sessionOutcomes,
          queuedPrompts,
          workPanelContexts,
          activeSessionId:
            state.activeSessionId === id ? undefined : state.activeSessionId,
          selectingSessionId:
            state.selectingSessionId === id ? undefined : state.selectingSessionId,
          messages: state.activeSessionId === id ? [] : state.messages,
          isRunning: state.activeSessionId === id ? false : state.isRunning,
          pendingPermissions,
          pendingAsks,
          latestTurnResults,
          planningStates,
          pendingPlans,
          planCheckpoints,
          sessionCompactions,
          sessionHistory,
          navStack,
          navIndex: Math.min(state.navIndex, navStack.length - 1),
        };
      });
      persistCurrentSidebar(get);
      await get().refreshSessions();
    },

    setSessionSort: (sort) => {
      set((state) => ({
        sessionView: { ...state.sessionView, sort, sortBy: sort },
      }));
      persistCurrentSidebar(get);
    },

    setSessionArchiveVisibility: (show) => {
      set((state) => ({
        sessionView: { ...state.sessionView, archived: show, showArchived: show },
      }));
      persistCurrentSidebar(get);
    },

    setSessionView: (view) => {
      if (typeof view === "boolean") {
        get().setSessionArchiveVisibility(view);
        return;
      }
      if (view.sort || view.sortBy) {
        get().setSessionSort(view.sort ?? view.sortBy ?? get().sessionView.sort);
      }
      if (view.archived !== undefined || view.showArchived !== undefined) {
        get().setSessionArchiveVisibility(
          view.archived ?? view.showArchived ?? false,
        );
      }
    },

    setShowArchived: (show) => {
      get().setSessionArchiveVisibility(show);
    },

    archiveProject: (path) => {
      const key = normalizeProjectPath(path);
      if (!key) return;
      set((state) => ({
        projectMeta: {
          ...state.projectMeta,
          [key]: { ...(state.projectMeta[key] || {}), archived: true },
        },
      }));
      persistCurrentSidebar(get);
    },

    toggleProjectPinned: (path, requestedPinned) => {
      const key = normalizeProjectPath(path);
      if (!key) return;
      set((state) => {
        const pinned = requestedPinned ?? !projectIsPinned(key, state.projectMeta);
        return {
          projectMeta: {
            ...state.projectMeta,
            [key]: { ...(state.projectMeta[key] || {}), pinned },
          },
        };
      });
      try {
        setProjectPinned(path, projectIsPinned(key, get().projectMeta));
      } catch {
        // The durable recent-project index is optional in restricted contexts.
      }
      persistCurrentSidebar(get);
    },

    renameProject: (path, name) => {
      const key = normalizeProjectPath(path);
      if (!key) return;
      const normalizedName = normalizeProjectName(name);
      if (!normalizedName) {
        throw new Error(i18n.t("errors.projectNameLength"));
      }
      set((state) => ({
        projectMeta: {
          ...state.projectMeta,
          [key]: { ...(state.projectMeta[key] || {}), name: normalizedName },
        },
        openProjects: state.openProjects.map((project) =>
          normalizeProjectPath(project.path) === key
            ? { ...project, name: normalizedName }
            : project,
        ),
        workspace:
          state.workspace && normalizeProjectPath(state.workspace.path) === key
            ? { ...state.workspace, name: normalizedName }
            : state.workspace,
      }));
      try {
        renameRecentProject(path, normalizedName);
      } catch {
        // Recent projects are a best-effort renderer cache.
      }
      persistCurrentSidebar(get);
    },

    toggleProjectArchived: (path) => {
      const key = normalizeProjectPath(path);
      if (!key) return;
      set((state) => {
        const archived = !projectIsArchived(key, state.projectMeta);
        return {
          projectMeta: {
            ...state.projectMeta,
            [key]: { ...(state.projectMeta[key] || {}), archived },
          },
        };
      });
      persistCurrentSidebar(get);
    },

    restoreProject: (path) => {
      const key = normalizeProjectPath(path);
      if (!key) return;
      set((state) => ({
        projectMeta: {
          ...state.projectMeta,
          [key]: { ...(state.projectMeta[key] || {}), archived: false },
        },
      }));
      persistCurrentSidebar(get);
    },

    setProjectCollapsed: (path, collapsed) => {
      const key = normalizeProjectPath(path);
      if (!key) return;
      set((state) => {
        const next = collapsed ?? !projectIsCollapsed(key, state.projectMeta);
        return {
          projectCollapsed: { ...state.projectCollapsed, [key]: next },
          projectMeta: {
            ...state.projectMeta,
            [key]: { ...(state.projectMeta[key] || {}), collapsed: next },
          },
        };
      });
      persistCurrentSidebar(get);
    },

    toggleProjectCollapsed: (path) => get().setProjectCollapsed(path),

    setProjectSort: (sort) => {
      set({ projectSort: sort });
      persistCurrentSidebar(get);
    },

    reorderProjects: (paths) => {
      const orderedKeys: string[] = [];
      const seen = new Set<string>();
      for (const path of paths) {
        const key = normalizeProjectPath(path);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        orderedKeys.push(key);
      }
      if (orderedKeys.length < 2) return;
      set((state) => {
        const projectMeta = { ...state.projectMeta };
        orderedKeys.forEach((key, index) => {
          projectMeta[key] = { ...(projectMeta[key] || {}), order: index };
        });
        return { projectMeta, projectSort: "manual" };
      });
      persistCurrentSidebar(get);
    },

    getVisibleSessions: (options) => {
      const state = get();
      const includeArchived = options?.includeArchived ?? state.sessionView.archived;
      const scoped =
        options && "projectPath" in options
          ? state.sessions.filter((session) =>
              sessionMatchesProject(session, options.projectPath),
            )
          : state.sessions;
      return sortSessions(
        scoped,
        state.sessionMeta,
        state.sessionView.sort,
        includeArchived,
      );
    },

    getSortedProjects: () => {
      const state = get();
      const projects = state.openProjects.filter(
        (project) => !projectIsArchived(project.path, state.projectMeta),
      );
      return sortProjects(projects, state.projectMeta, state.projectSort);
    },
  };
}
