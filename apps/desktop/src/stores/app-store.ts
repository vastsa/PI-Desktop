import { create } from "zustand";
import i18n from "i18next";
import type {
  AgentEventEnvelope,
  AgentStatus,
  AgentPromptAttachment,
  AskToolResolution,
  AppError,
  AppNotification,
  AppSettings,
  AppVersionInfo,
  ContextCompactionMark,
  ContextCompactionRecord,
  ModelInfo,
  OnboardingState,
  Mode,
  PlanProposal,
  PlanResolveRequest,
  PlanResolutionResult,
  PlanningState,
  PlanningStateEvent,
  PluginSummary,
  PluginTheme,
  PluginViewMeta,
  PermissionMode,
  ProjectWorkspace,
  ProposalKind,
  ProviderPublic,
  ReviewRollbackResult,
  SessionDetail,
  SessionSummary,
  ThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";
import {
  contextCompactionMark,
  ErrorCodes as SharedErrorCodes,
  initialThinkingLevelForBinding,
  modeForProposalKind,
  modelIdsMatch,
  normalizeMode,
  normalizeProposalKind,
  PROTOCOL_VERSION,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import type { SettingsTabId } from "../lib/settings-search";
import { createNavigationIntentController } from "../lib/navigation-intent";
import { scheduleHomeDraftAdopt } from "../lib/composer-draft-cache";
import {
  commitForkedSessionState,
  forkedSessionMessages,
  FORKED_SESSION_WINDOW,
} from "../lib/session-fork";
import {
  EMPTY_SESSION_WINDOW,
  sessionIsReusableEmpty,
} from "../lib/session-create";
import {
  rememberProject,
  renameRecentProject,
  setProjectPinned,
} from "../lib/recent-projects";
import { applyOptimisticSessionConfiguration } from "../lib/session-thinking";
import {
  RETAINED_SESSION_PANE_LIMIT,
  clearSessionPanes,
  recordPaneTranscript,
  releaseSessionPane,
  retainSessionPane,
} from "../lib/session-panes";
import { normalizeProjectPath, sessionMatchesProject } from "../lib/sidebar-session-groups";
import {
  dedupeSessionMessages,
  mergeLiveSessionMessages,
  removeLiveSessionMessage,
  optimisticUserMessage,
  upsertLiveSessionMessage,
  durableCoversLiveSessionMessages,
} from "../lib/session-transcript";
import {
  latestSessionOutcomes,
  type SidebarSessionOutcome,
} from "../lib/sidebar-session-status";
import {
  loadSidebarPreferences,
  projectIsArchived,
  projectIsCollapsed,
  projectIsPinned,
  projectWorkspaceFromPath,
  saveSidebarPreferences,
  sessionIsArchived,
  sessionIsPinned,
  sortProjects,
  sortSessions,
  normalizeProjectName,
  type ProjectMeta,
  type ProjectSort,
  type SessionMeta,
  type SessionSort,
} from "../lib/sidebar-preferences";
import { settleStoppedAssistantMetrics } from "../lib/context-usage";
import { formatToolValue } from "../lib/tool-display";
import { withReviewChangeState } from "../lib/workspace-review";
import {
  fileWorkPanelTab,
  shouldOpenReviewArtifact,
  toolWorkPanelTab,
} from "../lib/work-panel-tabs";
import {
  clearSessionPermissions,
  enqueuePermission,
  headPermission,
  removePermission,
  removePermissionForToolCall,
  sessionPermissions,
  type PermissionQueues,
} from "../lib/pending-permissions";
import {
  clearSessionAsks,
  enqueueAsk,
  headAsk,
  removeAsk,
  removeAskForToolCall,
  type AskQueues,
} from "../lib/pending-asks";
import {
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from "../lib/work-panel-resize";
import {
  isActivePlanExecution,
  isPendingPlan,
  latestPlanProposal,
  mergePlanCheckpoint,
  terminalizeMissingPlan,
} from "../lib/plan-mode-state";
import {
  resolveComposerSmartStop,
  type ComposerDraftSnapshot,
  type ComposerPrefill,
} from "../lib/composer-smart-stop";
import {
  clearQueuedPromptSendNow,
  enqueueQueuedPrompt,
  prioritizeQueuedPrompt,
  queuedPromptForSession,
  removeQueuedPrompt,
  type QueuedPrompt,
  type QueuedPrompts,
} from "../lib/queued-prompts";
import type { AgentQueueChangedEvent, QueuedTurnSummary } from "@pi-desktop/shared";
import { settleBootstrapRequests } from "../lib/bootstrap-result";
import type { SubagentPanelSelection } from "../lib/subagent-panel";
import {
  createSessionRuntime,
  type SessionRuntime,
  type SubmittedComposerDraft,
} from "./runtime/session-runtime";
import type { StoreAccess } from "./slices/types";
import {
  createWorkPanelSlice,
  currentWorkPanelContext,
  switchWorkPanelSession,
} from "./slices/work-panel-slice";
import {
  createInitialState,
  initialSidebarPreferences,
} from "./slices/initial-state";
import type {
  AgentTurnResult,
  DraftSessionConfiguration,
  PendingPlanRefreshResult,
  ToastItem,
  ToastOptions,
  ToastVariant,
} from "./app-state";
import { createSessionSlice } from "./slices/session-slice";
import { createQueueSlice } from "./slices/queue-slice";
import { createTranscriptSlice } from "./slices/transcript-slice";
import { createProjectSlice } from "./slices/project-slice";
import { createCatalogSlice } from "./slices/catalog-slice";
import { createEventsSlice } from "./slices/events-slice";
import { createInteractionSlice } from "./slices/interaction-slice";
import {
  createCatalogRuntime,
  type CatalogRuntime,
} from "./runtime/catalog-runtime";
import {
  createSessionCoordination,
  type SessionCoordination,
} from "./runtime/session-coordination";
import {
  createInteractionRuntime,
  type InteractionRuntime,
} from "./runtime/interaction-runtime";
import {
  createSessionTitleRuntime,
  isDefaultSessionTitle,
  promptFallbackSessionTitle,
  untitledTaskTitle,
} from "./runtime/session-title-runtime";
import { createInteractivePromptNotifier } from "./runtime/notification-runtime";
export type {
  AgentTurnResult,
  DraftSessionConfiguration,
  PendingPlanRefreshResult,
  ToastItem,
  ToastOptions,
  ToastVariant,
} from "./app-state";
export { isDefaultSessionTitle } from "./runtime/session-title-runtime";

export type { WorkPanelTab } from "../lib/work-panel-tabs";

function promptAttachmentsFromDraft(
  references: ComposerDraftSnapshot["fileReferences"],
): AgentPromptAttachment[] {
  return references.flatMap((reference) => {
    const kind =
      reference.kind ??
      (/\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(reference.path)
        ? "image"
        : "file");
    // Inline chips use tokens for both files and images. Ordinary file chips
    // already serialize to @path text (the model can Read them); only image
    // chips need the structured transport for vision/fallback handling.
    if (reference.token && kind !== "image") return [];
    return [
      {
        path: reference.path,
        name: reference.name,
        kind,
        ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
      },
    ];
  });
}

function promptAttachmentsFromMessage(
  attachments: UiMessage["attachments"],
): AgentPromptAttachment[] {
  return (attachments ?? []).map((attachment) => ({
    path: attachment.ref,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  }));
}

// Sessions created before locale switches keep their old default title, so
// match against every locale's defaults (case-insensitive), not just the
// active locale's.
function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function viewingSessionIdForPrompt(
  state: Pick<AppState, "page" | "activeSessionId">,
  sessionId: string,
): string | null {
  return state.page === "chat" && state.activeSessionId === sessionId
    ? sessionId
    : null;
}

const SESSION_TRANSCRIPT_CACHE_LIMIT = 20;
export const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
export const SESSION_TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;
export { RETAINED_SESSION_PANE_LIMIT };
// Preserve the original 320px tool-content minimum beside the 44px activity rail.
export { WORK_PANEL_DEFAULT_WIDTH, WORK_PANEL_MIN_WIDTH };

function messageErrorFromUnknown(error: unknown): AppError {
  const value = error as {
    code?: string;
    message?: string;
    retriable?: boolean;
  };
  return {
    code: value?.code || "INTERNAL",
    message:
      error instanceof Error
        ? error.message
        : typeof value?.message === "string"
          ? value.message
          : String(error),
    retriable: value?.retriable === true,
  };
}

function assistantErrorMessage(error: AppError): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    status: "error",
    isError: true,
    error,
  };
}

/** Project planning state and proposal kind determine the durable mode shown in the sidebar. */
function sessionModeForPlanningState(
  state: PlanningState,
  kind: ProposalKind | undefined,
): Mode {
  if (state === "inactive") return "agent";
  return modeForProposalKind(kind ?? "plan");
}

export type AppState = import("./app-state").AppState;

function openPlanArtifact(
  proposal: PlanProposal,
  openWorkPanelTabForSession: AppState["openWorkPanelTabForSession"],
) {
  const relativePath = proposal.artifact?.relativePath;
  if (!relativePath) return;
  openWorkPanelTabForSession(
    proposal.sessionId,
    fileWorkPanelTab(relativePath),
  );
}

function decorateSessions(
  sessions: SessionSummary[],
  meta: Record<string, SessionMeta>,
): SessionSummary[] {
  return sessions.map((session) => ({
    ...session,
    pinned: sessionIsPinned(session.id, meta),
    archived: sessionIsArchived(session.id, meta),
  }));
}

function promoteProjectPath(paths: string[], rawPath: string): string[] {
  const key = normalizeProjectPath(rawPath);
  if (!key) return paths;
  const withoutPath = paths.filter(
    (path) => normalizeProjectPath(path) !== key,
  );
  return [...withoutPath, rawPath];
}

function removeProjectPath(paths: string[], rawPath: string): string[] {
  const key = normalizeProjectPath(rawPath);
  return key
    ? paths.filter((path) => normalizeProjectPath(path) !== key)
    : paths;
}

function upsertWorkspace(
  projects: ProjectWorkspace[],
  workspace: ProjectWorkspace,
): ProjectWorkspace[] {
  const key = normalizeProjectPath(workspace.path);
  if (!key) return projects;
  const index = projects.findIndex((item) => normalizeProjectPath(item.path) === key);
  if (index < 0) return [...projects, workspace];
  const next = projects.slice();
  next[index] = { ...next[index], ...workspace };
  return next;
}

function withProjectDisplayName(
  workspace: ProjectWorkspace,
  projectMeta: Record<string, ProjectMeta>,
): ProjectWorkspace {
  const key = normalizeProjectPath(workspace.path);
  const name = key ? projectMeta[key]?.name : undefined;
  return name ? { ...workspace, name } : workspace;
}

function preferencesFromState(state: Pick<
  AppState,
  | "sessionMeta"
  | "projectMeta"
  | "projectSort"
  | "sessionView"
  | "openProjectPaths"
>) {
  return {
    sessionMeta: state.sessionMeta,
    projectMeta: state.projectMeta,
    projectSort: state.projectSort,
    sessionView: state.sessionView,
    openProjectPaths: state.openProjectPaths,
  };
}

function persistCurrentSidebar(getState: () => AppState): void {
  saveSidebarPreferences(preferencesFromState(getState()));
}

/** Append a freshly installed checkpoint, or replace a retried one by id. */
function withCompactionMark(
  marks: ContextCompactionMark[] | undefined,
  mark: ContextCompactionMark,
): ContextCompactionMark[] {
  return [...(marks ?? []).filter((existing) => existing.id !== mark.id), mark];
}

let storeAccess: StoreAccess | null = null;
const runtimeStoreAccess: StoreAccess = {
  get: () => {
    if (!storeAccess) throw new Error("App store is not initialized");
    return storeAccess.get();
  },
  set: (update) => {
    if (!storeAccess) throw new Error("App store is not initialized");
    storeAccess.set(update);
  },
};
const sessionRuntime: SessionRuntime = createSessionRuntime(runtimeStoreAccess);
const catalogRuntime: CatalogRuntime = createCatalogRuntime();
const interactionRuntime: InteractionRuntime = createInteractionRuntime();
const titleRuntime = createSessionTitleRuntime({
  ...runtimeStoreAccess,
  sessionRuntime,
  initialSessionMeta: initialSidebarPreferences.sessionMeta,
});
const manuallyRenamedSessionIds = titleRuntime.manualSessionTitles;
const { triggerAutoTitleSummarization } = titleRuntime;
const notifyInteractivePrompt = createInteractivePromptNotifier(
  runtimeStoreAccess.get,
);
const sessionCoordination: SessionCoordination = createSessionCoordination({
  ...runtimeStoreAccess,
  runtime: sessionRuntime,
  decorateSessions,
  withoutRecordKey,
  untitledTaskTitle,
});
const {
  flushPendingSessionConfiguration,
  rememberSessionCompactions,
  commitForkedSession,
  persistSessionAndSelect,
  materializeDraftSession: materializeDraftSessionInternal,
} = sessionCoordination;

export const useAppStore = create<AppState>((set, get) => {
  storeAccess = { get, set };
  return {
  ...createInitialState(),

  ...createSessionSlice({
    get,
    set,
    runtime: sessionRuntime,
    decorateSessions,
    withoutRecordKey,
    sessionModeForPlanningState,
    openPlanArtifact,
    rememberSessionCompactions,
    commitForkedSession,
    persistSessionAndSelect,
  }),

  ...createQueueSlice({
    get,
    set,
    runtime: sessionRuntime,
    promptAttachmentsFromDraft,
    withoutRecordKey,
    promptFallbackSessionTitle,
    untitledTaskTitle,
    isDefaultSessionTitle,
    viewingSessionIdForPrompt,
    messageErrorFromUnknown,
    assistantErrorMessage,
    materializeDraftSession: materializeDraftSessionInternal,
  }),

  ...createTranscriptSlice({
    get,
    set,
    runtime: sessionRuntime,
    promptAttachmentsFromMessage,
    viewingSessionIdForPrompt,
    flushPendingSessionConfiguration,
  }),

  ...createProjectSlice({
    get,
    set,
    runtime: sessionRuntime,
    manualSessionTitles: manuallyRenamedSessionIds,
    withoutRecordKey,
    withProjectDisplayName,
    promoteProjectPath,
    removeProjectPath,
    upsertWorkspace,
    persistCurrentSidebar,
  }),

  ...createCatalogSlice({
    get,
    set,
    catalogRuntime,
    sessionRuntime,
    decorateSessions,
    withoutRecordKey,
  }),

  ...createEventsSlice({
    get,
    set,
    runtime: sessionRuntime,
    withoutRecordKey,
    sessionModeForPlanningState,
    openPlanArtifact,
    notifyInteractivePrompt,
    triggerAutoTitleSummarization,
    flushPendingSessionConfiguration,
    assistantErrorMessage,
    withCompactionMark,
  }),

  ...createInteractionSlice({
    get,
    set,
    runtime: sessionRuntime,
    interactionRuntime,
  }),

  bootstrap: async () => {
    let recoveredSettings: AppSettings | undefined;
    try {
      const settingsRequest = api.getSettings().then(async (settingsRaw) => {
        let settings = settingsRaw
          ? {
              ...settingsRaw,
              defaultMode: normalizeMode(
                (settingsRaw as { defaultMode?: unknown }).defaultMode,
              ),
            }
          : settingsRaw;
        // First-run default per D003: Agent. Never force-rewrite an existing
        // user choice on boot.
        if (settings && !settings.defaultMode) {
          const next = { ...settings, defaultMode: "agent" as const };
          try {
            await api.setSettings(next);
            settings = next;
          } catch {
            settings = next;
          }
        }
        return settings;
      });
      const snapshotRequest = Promise.all([
        api.getVersion(),
        api.health(),
        api.listSessions(),
        api.listProviders(),
        api.getProject(),
        api.getOnboarding(),
        api.listPlugins(),
        api.listNotifications({ limit: 200 }),
        api.pendingPlans(),
      ]);
      const bootstrapResult = await settleBootstrapRequests(
        settingsRequest,
        snapshotRequest,
      );
      recoveredSettings = bootstrapResult.settings;
      if (!bootstrapResult.ok) {
        throw bootstrapResult.error;
      }
      const settings = bootstrapResult.settings;
      const [
        version,
        health,
        sessions,
        providers,
        project,
        onboarding,
        plugins,
        notifications,
        pendingPlansResult,
      ] = bootstrapResult.snapshot;
      if (version.protocolVersion !== PROTOCOL_VERSION) {
        set({
          error: `Protocol mismatch: UI ${PROTOCOL_VERSION} vs app ${version.protocolVersion}`,
          errorCode: "PROTOCOL_MISMATCH",
        });
      }
      const cachedProviderModels = Object.fromEntries(
        (
          await Promise.all(
            providers.providers.map(async (provider) => {
              try {
                const cached = await api.listProviderModels({
                  providerId: provider.id,
                  source: "cache",
                });
                return cached.models.length > 0
                  ? ([provider.id, cached.models] as const)
                  : null;
              } catch {
                return null;
              }
            }),
          )
        ).filter((entry): entry is readonly [string, ModelInfo[]] => entry !== null),
      );
      const currentWorkspace = project.workspace
        ? withProjectDisplayName(project.workspace, get().projectMeta)
        : null;
      const persistedPaths = get().openProjectPaths;
      // Only explicitly retained tabs are restored. Historical sessions stay
      // available in Projects, but must not silently reopen a tab that was
      // intentionally closed.
      const openProjectPaths = currentWorkspace?.path
        ? promoteProjectPath(persistedPaths, currentWorkspace.path)
        : persistedPaths;
      const openProjects = openProjectPaths.map((path) =>
        withProjectDisplayName(projectWorkspaceFromPath(path), get().projectMeta),
      );
      const hydratedProjects = currentWorkspace
        ? upsertWorkspace(openProjects, currentWorkspace)
        : openProjects;
      const hydratedSessions = decorateSessions(sessions.sessions, get().sessionMeta);
      const latestPlanCheckpoints = Object.fromEntries(
        hydratedSessions.flatMap((session) => {
          const proposal = latestPlanProposal(
            pendingPlansResult.plans,
            session.id,
          );
          return proposal ? [[session.id, proposal] as const] : [];
        }),
      );
      const activePendingPlans = pendingPlansResult.plans.filter(isPendingPlan);
      const pendingPlans = Object.fromEntries(
        activePendingPlans.map((proposal) => [proposal.sessionId, proposal]),
      );
      const planningStates: Record<string, PlanningState> = Object.fromEntries(
        hydratedSessions.map((session) => [
          session.id,
          session.mode === "plan" ? ("planning" as const) : ("inactive" as const),
        ]),
      );
      for (const proposal of activePendingPlans) {
        planningStates[proposal.sessionId] = "awaiting_approval";
      }
      set({
        ready: true,
        version,
        healthOk: health.ok,
        settings,
        sessions: hydratedSessions,
        providers: providers.providers,
        providerModels: cachedProviderModels,
        workspace: currentWorkspace,
        activeProjectPath: currentWorkspace?.path,
        openProjectPaths,
        openProjects: hydratedProjects,
        onboarding,
        plugins: plugins.plugins,
        planningStates,
        pendingPlans,
        planCheckpoints: latestPlanCheckpoints,
        notifications: notifications.notifications,
        unreadNotificationCount: notifications.unreadCount,
        sessionOutcomes: latestSessionOutcomes(notifications.notifications),
      });
      for (const proposal of activePendingPlans) {
        openPlanArtifact(proposal, get().openWorkPanelTabForSession);
      }
      saveSidebarPreferences(preferencesFromState(get()));
      if (currentWorkspace?.path) {
        rememberProject({
          path: currentWorkspace.path,
          name: currentWorkspace.name || currentWorkspace.path,
          branch: currentWorkspace.branch,
        });
      }
      // Codex opens an empty draft home ("What can I help you build?") rather than
      // restoring a prior transcript as the first paint. A live host plan is
      // the exception: its owning session must be visible so approval can be
      // restored after a renderer reload.
      const livePlanSessionId = activePendingPlans[0]?.sessionId;
      if (livePlanSessionId) {
        await get().selectSession(livePlanSessionId);
      } else {
        // App startup keeps the home composer unpersisted. Explicit New Task
        // actions use the durable empty-session slot below, but launch itself
        // must not create a history row merely because the app was opened.
        set((s) => {
          const stack = s.navStack.slice(0, s.navIndex + 1);
          const nextStack = [...stack, { page: "chat" as const }].slice(-50);
          return {
            ...switchWorkPanelSession(s, undefined),
            ...clearSessionPanes(),
            activeSessionId: undefined,
            draftConfiguration: null,
            messages: [],
            page: "chat" as const,
            navStack: nextStack,
            navIndex: nextStack.length - 1,
            isRunning: false,
          };
        });
      }
    } catch (e) {
      set({
        ready: true,
        healthOk: false,
        ...(recoveredSettings ? { settings: recoveredSettings } : {}),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  ...createWorkPanelSlice({
    get,
    set,
    isSessionSelectionPending: (sessionId) =>
      sessionRuntime.isSessionSelectionPending(sessionId),
  }),


  clearComposerPrefill: () => set({ composerPrefill: null }),
  };
});

/**
 * Mirror the live transcript into the active session's retained snapshot
 * (ADR 0137).
 *
 * `messages` is written from ~30 places (streaming events, edits, retries,
 * revisions, smart stop). Keeping the snapshot in step here means none of them
 * has to remember the pane, and the pane the user leaves keeps exactly what it
 * last painted instead of the transcript it had when it was opened.
 */
useAppStore.subscribe((state, previous) => {
  if (
    state.messages === previous.messages &&
    state.activeSessionId === previous.activeSessionId
  ) {
    return;
  }
  const id = state.activeSessionId;
  if (!id) return;
  if (state.runningSessions[id] || previous.runningSessions[id]) {
    sessionRuntime.liveSessionTranscripts.add(id);
  }
  sessionRuntime.cacheSessionTranscript(
    id,
    state.messages,
    state.sessionHistory[id],
  );
  if (state.retainedTranscripts[id] === state.messages) return;
  useAppStore.setState((current) =>
    current.activeSessionId === id
      ? recordPaneTranscript(current, id, current.messages)
      : {},
  );
});

export async function materializeDraftSession(
  intent?: number,
): Promise<string | null> {
  return sessionCoordination.materializeDraftSession(intent);
}
