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
import { createFrameBatcher } from "../lib/frame-batcher";
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
  WORK_PANEL_MAX_WIDTH,
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
export type {
  AgentTurnResult,
  DraftSessionConfiguration,
  PendingPlanRefreshResult,
  ToastItem,
  ToastOptions,
  ToastVariant,
} from "./app-state";

const ErrorCodes = {
  ...SharedErrorCodes,
  PLAN_APPROVAL_TIMEOUT: "PLAN_APPROVAL_TIMEOUT",
} as const;

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
const LEGACY_DEFAULT_TITLES = new Set(["new task", "new chat", "新建任务", "新对话"]);
const SESSION_TITLE_FALLBACK_LENGTH = 48;

function promptFallbackSessionTitle(userPrompt: string, emptyTitle: string): string {
  return userPrompt.trim().replace(/\s+/g, " ").slice(0, SESSION_TITLE_FALLBACK_LENGTH) || emptyTitle;
}

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

function notifyInteractivePrompt(
  sessionId: string,
  kind: "ask" | "permission" | "plan",
  payload?: { question?: string; toolName?: string },
) {
  const session = useAppStore.getState().sessions.find((s) => s.id === sessionId);
  const sessionTitle = session?.title || i18n.t("chat.untitledTask");
  let title = "";
  let body = "";
  if (kind === "ask") {
    title = i18n.t("notifications.askTitle", { sessionTitle });
    body = payload?.question?.trim() || i18n.t("notifications.askBodyFallback");
  } else if (kind === "permission") {
    title = i18n.t("notifications.permissionTitle", { sessionTitle });
    body = i18n.t("notifications.permissionBody", {
      toolName: payload?.toolName || "tool",
    });
  } else if (kind === "plan") {
    title = i18n.t("notifications.planApprovalTitle", { sessionTitle });
    body = i18n.t("notifications.planApprovalBody");
  }
  void api
    .showNativeNotification({
      id: crypto.randomUUID(),
      sessionId,
      kind: "interactive",
      title,
      body,
    })
    .catch(() => undefined);
}

const manuallyRenamedSessionIds = new Set<string>();
const summarizedSessionIds = new Set<string>();

async function triggerAutoTitleSummarization(sessionId: string) {
  if (!sessionId) return;
  if (manuallyRenamedSessionIds.has(sessionId)) return;
  if (summarizedSessionIds.has(sessionId)) return;

  const state = useAppStore.getState();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const messages =
    sessionId === state.activeSessionId
      ? state.messages
      : sessionTranscriptCache.get(sessionId) ?? [];

  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser?.content) return;
  // The marker covers renames made in this renderer and survives restart.
  // The title check also protects custom titles created before the marker was
  // introduced, while retaining the prompt fallback until its summary lands.
  if (
    state.sessionMeta[sessionId]?.manualTitle ||
    (!isDefaultSessionTitle(session.title) &&
      session.title.trim() !== promptFallbackSessionTitle(firstUser.content, ""))
  ) {
    return;
  }

  const firstAssistant = messages.find(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim(),
  );

  summarizedSessionIds.add(sessionId);

  try {
    const res = await api.summarizeSessionTitle({
      sessionId,
      userPrompt: firstUser.content,
      assistantReply:
        typeof firstAssistant?.content === "string" ? firstAssistant.content : undefined,
    });
    const nextTitle = res?.title?.trim();
    if (nextTitle && !manuallyRenamedSessionIds.has(sessionId)) {
      await api.renameSession(sessionId, nextTitle);
      await useAppStore.getState().refreshSessions();
    }
  } catch {
    // Non-fatal: keep current truncated prompt title as fallback
  }
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

// Design-system §11.8: default 4s auto-dismiss, errors linger 8s.
const TOAST_DURATION_MS = 4000;
const TOAST_ERROR_DURATION_MS = 8000;
// Visible stack cap — oldest toasts drop first when exceeded.
const TOAST_STACK_LIMIT = 4;
let toastSeq = 0;

function untitledTaskTitle() {
  return i18n.t("chat.untitledTask");
}

export function isDefaultSessionTitle(title?: string | null) {
  const trimmed = (title || "").trim().toLowerCase();
  return (
    !trimmed ||
    LEGACY_DEFAULT_TITLES.has(trimmed) ||
    trimmed === untitledTaskTitle().toLowerCase() ||
    trimmed === i18n.t("nav.newChat").toLowerCase()
  );
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

for (const [sessionId, meta] of Object.entries(initialSidebarPreferences.sessionMeta)) {
  if (meta.manualTitle) manuallyRenamedSessionIds.add(sessionId);
}

// Cross-session tool calls never enter `messages`, and a renderer reload can
// lose the running row before tool_end arrives, so retain the start metadata
// long enough to build a complete terminal row when needed.
const toolStartsByCallId = new Map<
  string,
  {
    toolName: string;
    args: unknown;
    createdAt: string;
    parentToolCallId?: string;
    agentName?: string;
  }
>();
const TOOL_NAME_CACHE_LIMIT = 512;
const providerModelLoads = new Map<string, Promise<void>>();
const refreshedProviderModels = new Set<string>();
let providerModelsGeneration = 0;
let pluginRefreshInFlight: Promise<void> | null = null;

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

/**
 * Record (or clear) the compaction rows a session shows. A session loaded
 * without a checkpoint drops its entry so a forked or rewritten transcript
 * never keeps showing its ancestor's compactions.
 */
function rememberSessionCompactions(
  sessionId: string,
  session:
    | {
        compaction?: ContextCompactionRecord;
        compactions?: ContextCompactionRecord[];
      }
    | null
    | undefined,
): void {
  const records =
    session?.compactions ??
    (session?.compaction ? [session.compaction] : []);
  const marks = records.map(contextCompactionMark);
  useAppStore.setState((state) => ({
    sessionCompactions:
      marks.length > 0
        ? { ...state.sessionCompactions, [sessionId]: marks }
        : withoutRecordKey(state.sessionCompactions, sessionId),
  }));
}

/**
 * Record a freshly forked child session, and optionally activate it.
 *
 * `api.forkSession` has already committed the child on the host by the time it
 * resolves, so the sidebar row and the cached transcript are written even when a
 * newer navigation has taken over the view. Only the visible switch - active
 * session, transcript, work panel, history entry - is conditional. Previously
 * both were skipped together, which left a branch on disk that the UI never
 * showed until the next manual refresh.
 */
function commitForkedSession(
  session: SessionDetail,
  options: { activate: boolean; clearError?: boolean },
): void {
  const { messages: _forkedMessages, ...summary } = session;
  const messages = forkedSessionMessages(session);
  const historyWindow = { ...FORKED_SESSION_WINDOW };
  cacheSessionTranscript(summary.id, messages, historyWindow);
  useAppStore.setState((current) => {
    const commit = commitForkedSessionState(current, summary, {
      activate: options.activate,
    });
    const shared: Partial<AppState> = {
      sessions: decorateSessions(commit.sessions, current.sessionMeta),
      sessionHistory: { ...current.sessionHistory, [summary.id]: historyWindow },
      planningStates: {
        ...current.planningStates,
        [summary.id]: summary.mode === "plan" ? "planning" : "inactive",
      },
      ...(options.clearError ? { error: null, errorCode: null } : {}),
    };
    if (!commit.activated) return shared;
    return {
      ...switchWorkPanelSession(current, summary.id),
      ...shared,
      ...retainSessionPane(current, summary.id, messages),
      activeSessionId: summary.id,
      messages,
      page: "chat" as const,
      isRunning: false,
      navStack: commit.navStack as AppState["navStack"],
      navIndex: commit.navIndex,
    };
  });
  rememberSessionCompactions(summary.id, session);
  void useAppStore.getState().restorePendingPlan(summary.id);
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
const planResolutionRequests = new Map<string, Promise<PlanResolutionResult>>();
const {
  pendingNewSessionRequests,
  sessionTranscriptCache,
  liveSessionTranscripts,
  sessionHistoryCache,
  submittedComposerDrafts,
  pendingSessionConfigurations,
  sessionConfigurationFlushes,
  sessionOlderLoads,
  beginNavigationIntent,
  navigationIntentIsCurrent,
  newSessionScopeKey,
  latestSessionInScope,
  liveMessageCountForSession,
  cacheSessionTranscript,
  loadSessionDetail,
  loadFullSessionMessages,
  insertOptimisticUserMessage,
  retractOptimisticUserMessage,
  cacheBackgroundTranscriptEvent,
  mergeSessionConfiguration,
  nextPlanSyncGeneration,
  planSyncGeneration,
} = sessionRuntime;

let flushingStreamUpdates = false;
const streamUpdates = createFrameBatcher<AgentEventEnvelope>((envelopes) => {
  flushingStreamUpdates = true;
  try {
    for (const envelope of envelopes) {
      // Re-enter the public action with batching disabled so all regular
      // session/tool lifecycle ordering stays in one place.
      useAppStore.getState().handleAgentEvent(envelope);
    }
  } finally {
    flushingStreamUpdates = false;
  }
});

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
    materializeDraftSession,
  }),

  ...createTranscriptSlice({
    get,
    set,
    runtime: sessionRuntime,
    promptAttachmentsFromMessage,
    viewingSessionIdForPrompt,
    flushPendingSessionConfiguration,
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

  activateProject: async (path, opts) => {
    const intent = opts?.navigationIntent ?? beginNavigationIntent();
    const preserveConversation = sessionRuntime.isSessionSelectionForIntent(intent);
    const requestedPath = path.trim();
    if (!requestedPath) return null;
    const result = await api.setProject(requestedPath);
    if (!navigationIntentIsCurrent(intent)) return null;
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
      // project/get reads the one host-owned active workspace. Do not let a
      // late response from a hover overwrite state after navigation moved to
      // another project.
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
    const intent = beginNavigationIntent();
    const key = normalizeProjectPath(path);
    if (!key) return;
    const state = get();
    const isActive = normalizeProjectPath(state.activeProjectPath) === key;
    const nextPaths = removeProjectPath(state.openProjectPaths, path);
    if (isActive) {
      const fallbackPath = nextPaths[nextPaths.length - 1];
      try {
        if (fallbackPath) {
          await get().activateProject(fallbackPath, { navigationIntent: intent });
        } else {
          await get().clearProject({ navigationIntent: intent });
        }
        if (!navigationIntentIsCurrent(intent)) return;
      } catch (error) {
        // Keep the current workspace/tab intact when the fallback fails.
        throw error;
      }
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
    const intent = beginNavigationIntent();
    const result = await api.cloneProject(url);
    if (!navigationIntentIsCurrent(intent)) return null;
    if (result.canceled || !result.workspace?.path) return null;
    return get().activateProject(result.workspace.path, { navigationIntent: intent });
  },

  openProject: async () => {
    const intent = beginNavigationIntent();
    const result = await api.openProject();
    if (!navigationIntentIsCurrent(intent)) return;
    if (!result.canceled && result.workspace) {
      const workspace = withProjectDisplayName(result.workspace, get().projectMeta);
      if (
        normalizeProjectPath(get().activeProjectPath) !==
        normalizeProjectPath(workspace.path)
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
        return {
          workspace,
          activeProjectPath: workspace.path,
          openProjectPaths,
          openProjects: upsertWorkspace(state.openProjects, workspace),
          page: "chat" as const,
          ...(switchesVisibleProject
            ? {
                ...clearSessionPanes(),
                activeSessionId: undefined,
                messages: [],
                isRunning: false,
              }
            : {}),
        };
      });
      if (workspace.path) {
        rememberProject({
          path: workspace.path,
          name: workspace.name || workspace.path,
          branch: workspace.branch,
        });
      }
      persistCurrentSidebar(get);
      const onboarding = await api.getOnboarding();
      if (!navigationIntentIsCurrent(intent)) return;
      set({ onboarding, page: "chat" });
    }
  },

  clearProject: async (opts) => {
    const intent = opts?.navigationIntent ?? beginNavigationIntent();
    const preserveConversation = sessionRuntime.isSessionSelectionForIntent(intent);
    await api.clearProject();
    if (!navigationIntentIsCurrent(intent)) return;
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
    if (!navigationIntentIsCurrent(intent)) return;
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
    manuallyRenamedSessionIds.add(id);
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
    // A running turn owns the current project's instructions and working
    // directory; the host rejects the move as well.
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
    manuallyRenamedSessionIds.delete(id);
    pendingSessionConfigurations.delete(id);
    sessionTranscriptCache.delete(id);
    sessionHistoryCache.delete(id);
    liveSessionTranscripts.delete(id);
    sessionOlderLoads.delete(id);
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
      get().setSessionArchiveVisibility(view.archived ?? view.showArchived ?? false);
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
    // Keep the projects page's legacy recents index in sync as well.
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
    const scoped = options && "projectPath" in options
      ? state.sessions.filter((session) =>
          sessionMatchesProject(session, options.projectPath),
        )
      : state.sessions;
    return sortSessions(scoped, state.sessionMeta, state.sessionView.sort, includeArchived);
  },

  getSortedProjects: () => {
    const state = get();
    const projects = state.openProjects.filter(
      (project) => !projectIsArchived(project.path, state.projectMeta),
    );
    return sortProjects(projects, state.projectMeta, state.projectSort);
  },

  refreshProviders: async () => {
    const [providers, sessions, settings, onboarding] = await Promise.all([
      api.listProviders(),
      api.listSessions(),
      api.getSettings(),
      api.getOnboarding(),
    ]);
    providerModelsGeneration += 1;
    refreshedProviderModels.clear();
    set((state) => ({
      providers: providers.providers,
      // Provider edits may change discovery settings. The next load hydrates
      // from SQLite first, then refreshes without presenting an empty menu.
      providerModels: {},
      sessions: decorateSessions(sessions.sessions, state.sessionMeta),
      settings,
      onboarding,
    }));
  },

  loadProviderModels: async (providerId) => {
    if (refreshedProviderModels.has(providerId)) return;
    const generation = providerModelsGeneration;
    const existing = providerModelLoads.get(providerId);
    if (existing) {
      await existing;
      if (providerModelLoads.get(providerId) === existing) {
        providerModelLoads.delete(providerId);
      }
      if (!refreshedProviderModels.has(providerId)) {
        await get().loadProviderModels(providerId);
      }
      return;
    }

    const load = (async () => {
      let hydrated = (get().providerModels[providerId]?.length ?? 0) > 0;
      if (!hydrated) {
        try {
          const cached = await api.listProviderModels({ providerId, source: "cache" });
          if (generation !== providerModelsGeneration) return;
          hydrated = cached.models.length > 0;
          set((state) => ({
            providerModels: {
              ...state.providerModels,
              [providerId]: cached.models,
            },
          }));
        } catch {
          // Continue to live discovery when the local cache is unavailable.
        }
      }

      try {
        const refreshed = await api.listProviderModels({
          providerId,
          source: "refresh",
        });
        if (generation !== providerModelsGeneration) return;
        // A catalog-derived list is still a usable answer for an endpoint that
        // publishes no /models route, so it commits like a remote one.
        if (
          (refreshed.source === "remote" || refreshed.source === "catalog") &&
          refreshed.models.length > 0
        ) {
          set((state) => ({
            providerModels: {
              ...state.providerModels,
              [providerId]: refreshed.models,
            },
          }));
        } else if (!hydrated && refreshed.models.length > 0) {
          set((state) => ({
            providerModels: {
              ...state.providerModels,
              [providerId]: refreshed.models,
            },
          }));
        }
      } catch {
        // Keep the cached catalog; the menu already has a usable fallback.
      } finally {
        if (generation === providerModelsGeneration) {
          refreshedProviderModels.add(providerId);
        }
      }
    })();
    providerModelLoads.set(providerId, load);
    try {
      await load;
    } finally {
      if (providerModelLoads.get(providerId) === load) {
        providerModelLoads.delete(providerId);
      }
    }
  },

  refreshPlugins: async () => {
    // Plugin crash/restart events can arrive in a burst. Share one host request
    // across the app shell and the Extensions page so a transient event storm
    // cannot consume every host RPC slot with identical list reads.
    if (pluginRefreshInFlight) return pluginRefreshInFlight;
    const load = (async () => {
      const plugins = await api.listPlugins();
      set({ plugins: plugins.plugins });
    })();
    pluginRefreshInFlight = load;
    try {
      await load;
    } finally {
      if (pluginRefreshInFlight === load) pluginRefreshInFlight = null;
    }
  },

  refreshPluginThemes: async () => {
    try {
      set({ pluginThemes: await api.listPluginThemes() });
    } catch {
      // A missing channel (older main process) must not break the shell; the
      // built-in themes keep working.
      set({ pluginThemes: [] });
    }
  },

  refreshPluginViews: async () => {
    try {
      set({ pluginViews: await api.listPluginViews() });
    } catch {
      // Same reasoning as themes: an older main process without the channel
      // leaves the panel with its built-in tool only, rather than breaking it.
      set({ pluginViews: [] });
    }
  },

  refreshNotifications: async () => {
    const result = await api.listNotifications({ limit: 200 });
    set((state) => ({
      notifications: result.notifications,
      unreadNotificationCount: result.unreadCount,
      sessionOutcomes: {
        ...state.sessionOutcomes,
        ...latestSessionOutcomes(result.notifications),
      },
    }));
  },

  receiveNotification: (notification) => {
    set((state) => {
      const withoutCurrent = state.notifications.filter(
        (item) => item.id !== notification.id,
      );
      const notifications = [notification, ...withoutCurrent].slice(0, 200);
      return {
        notifications,
        sessionOutcomes: {
          ...state.sessionOutcomes,
          [notification.sessionId]:
            notification.kind === "task.failed" ? "failed" : "completed",
        },
        unreadNotificationCount: notifications.reduce(
          (count, item) => count + (item.readAt ? 0 : 1),
          0,
        ),
      };
    });
  },

  markNotificationRead: async (id) => {
    const item = get().notifications.find((notification) => notification.id === id);
    if (!item || item.readAt) return;
    await api.markNotificationRead(id);
    const readAt = new Date().toISOString();
    set((state) => ({
      notifications: state.notifications.map((notification) =>
        notification.id === id ? { ...notification, readAt } : notification,
      ),
      unreadNotificationCount: Math.max(0, state.unreadNotificationCount - 1),
    }));
  },

  markAllNotificationsRead: async () => {
    if (get().unreadNotificationCount === 0) return;
    await api.markAllNotificationsRead();
    const readAt = new Date().toISOString();
    set((state) => ({
      notifications: state.notifications.map((notification) =>
        notification.readAt ? notification : { ...notification, readAt },
      ),
      unreadNotificationCount: 0,
    }));
  },

  clearNotifications: async () => {
    await api.clearNotifications();
    set({ notifications: [], unreadNotificationCount: 0 });
  },

  openNotification: async (id) => {
    const intent = beginNavigationIntent();
    const notification = get().notifications.find((item) => item.id === id);
    if (!notification) return;
    await get().markNotificationRead(id);
    if (!navigationIntentIsCurrent(intent)) return;
    await get().selectSession(notification.sessionId, {
      navigationIntent: intent,
    });
  },

  acknowledgeSessionOutcome: async (sessionId) => {
    // The sidebar check / cross flags an unseen result, so opening the
    // conversation clears it. Reading the backing notifications keeps it
    // cleared across a notification refresh or an app restart.
    set((s) =>
      s.sessionOutcomes[sessionId]
        ? { sessionOutcomes: withoutRecordKey(s.sessionOutcomes, sessionId) }
        : {},
    );
    const unread = get().notifications.filter(
      (item) => item.sessionId === sessionId && !item.readAt,
    );
    for (const item of unread) {
      await get().markNotificationRead(item.id);
    }
  },

  handlePlansChanged: (event) => {
    if (!event?.sessionId) return;
    nextPlanSyncGeneration(event.sessionId);
    set((state) => {
      const previousCheckpoint = state.planCheckpoints[event.sessionId];
      const checkpoint = mergePlanCheckpoint(
        previousCheckpoint,
        event,
      );
      const activeProposal =
        event.state === "awaiting_approval" &&
        isPendingPlan(checkpoint)
          ? checkpoint
          : undefined;
      const pendingPlans = activeProposal
        ? { ...state.pendingPlans, [event.sessionId]: activeProposal }
        : withoutRecordKey(state.pendingPlans, event.sessionId);
      const nextMode = sessionModeForPlanningState(
        event.state,
        // `planning` without a kind can only come from a pre-D198 host; the
        // checkpoint it just merged is the closest durable answer.
        event.kind ?? checkpoint?.kind,
      );
      const executionActive = isActivePlanExecution(checkpoint);
      const planExecutionWasActive = isActivePlanExecution(previousCheckpoint);
      const planExecutionRunChanged = executionActive || planExecutionWasActive;
      return {
        planningStates: {
          ...state.planningStates,
          [event.sessionId]: event.state,
        },
        planCheckpoints: checkpoint
          ? { ...state.planCheckpoints, [event.sessionId]: checkpoint }
          : state.planCheckpoints,
        pendingPlans,
        runningSessions: planExecutionRunChanged
          ? { ...state.runningSessions, [event.sessionId]: executionActive }
          : state.runningSessions,
        isRunning:
          state.activeSessionId === event.sessionId && planExecutionRunChanged
            ? executionActive
            : state.isRunning,
        sessions: state.sessions.map((session) =>
          session.id === event.sessionId
            ? { ...session, mode: nextMode }
            : session,
        ),
      };
    });
    const checkpoint = get().planCheckpoints[event.sessionId];
    if (event.state === "awaiting_approval" && isPendingPlan(checkpoint)) {
      openPlanArtifact(checkpoint, get().openWorkPanelTabForSession);
    }
    if (event.state === "awaiting_approval" && !event.proposal) {
      void get().restorePendingPlan(event.sessionId);
    }
    if (event.state === "inactive") {
      void get().refreshSessions();
    }
    if (event.state !== "awaiting_approval") {
      void get().refreshQueuedPrompts(event.sessionId);
    }
  },

  handleAgentEvent: (envelope) => {
    const event = envelope.event;
    if (event.type === "agent_end" || event.type === "error") {
      submittedComposerDrafts.delete(envelope.sessionId);
    }
    if (!flushingStreamUpdates) {
      if (event.type === "message_update") {
        streamUpdates.enqueue(
          `message:${envelope.sessionId}:${event.message.id}`,
          envelope,
        );
        return;
      }
      if (event.type === "tool_update") {
        streamUpdates.enqueue(
          `tool:${envelope.sessionId}:${event.toolCallId}`,
          envelope,
        );
        return;
      }
      // Terminal and control events must observe every pending partial update
      // before they settle running/error state.
      streamUpdates.flushNow();
    }
    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "tool_start" ||
      event.type === "tool_update" ||
      event.type === "tool_end"
    ) {
      // Completed assistant/tool rows can still be ahead of the durable page
      // after agent_end (D324). Keep live provenance until that page covers them.
      liveSessionTranscripts.add(envelope.sessionId);
    }
    if (event.type === "status") {
      set((state) => ({
        agentStatuses: {
          ...state.agentStatuses,
          [envelope.sessionId]: event.status,
        },
      }));
    }
    // Per-session run state: agents run independently per session, so track
    // running/finished for every envelope, visible session or not.
    if (
      event.type === "agent_start" ||
      event.type === "turn_start" ||
      event.type === "compaction_start"
    ) {
      set((s) => ({
        runningSessions: { ...s.runningSessions, [envelope.sessionId]: true },
        sessionOutcomes: withoutRecordKey(s.sessionOutcomes, envelope.sessionId),
        latestTurnResults: withoutRecordKey(
          s.latestTurnResults,
          envelope.sessionId,
        ),
      }));
    } else if (event.type === "compaction_end" && event.reason === "manual") {
      set((s) => ({
        runningSessions: { ...s.runningSessions, [envelope.sessionId]: false },
      }));
      void flushPendingSessionConfiguration(envelope.sessionId);
      void get().refreshQueuedPrompts(envelope.sessionId);
    } else if (
      event.type === "agent_end" ||
      event.type === "error"
    ) {
      // The terminal chat event updates the visible transcript only. Sidebar
      // terminal marks are notification-backed, so a focused current session
      // never creates its own unread completion marker.
      set((s) => ({
        runningSessions: { ...s.runningSessions, [envelope.sessionId]: false },
        agentStatuses: withoutRecordKey(s.agentStatuses, envelope.sessionId),
        pendingPermissions: clearSessionPermissions(
          s.pendingPermissions,
          envelope.sessionId,
        ),
        pendingAsks: clearSessionAsks(s.pendingAsks, envelope.sessionId),
        latestTurnResults:
          event.type === "error" && event.error.code === "TURN_ABORTED"
            ? withoutRecordKey(s.latestTurnResults, envelope.sessionId)
            : event.type === "agent_end" &&
                s.latestTurnResults[envelope.sessionId]?.status === "failed"
              ? s.latestTurnResults
              : {
                  ...s.latestTurnResults,
                  [envelope.sessionId]: {
                    status: event.type === "error" ? "failed" : "completed",
                    turnId:
                      envelope.turnId ?? `${envelope.sessionId}:${envelope.ts}`,
                    finishedAt: envelope.ts,
                    ...(event.type === "error"
                      ? { errorCode: event.error.code }
                      : {}),
                  },
                },
      }));
      void flushPendingSessionConfiguration(envelope.sessionId);
      if (event.type === "agent_end") {
        void get().refreshQueuedPrompts(envelope.sessionId);
      }
    }
    if (event.type === "planning_state") {
      nextPlanSyncGeneration(envelope.sessionId);
      set((state) => {
        const checkpoint = mergePlanCheckpoint(
          state.planCheckpoints[envelope.sessionId],
          { ...event, sessionId: envelope.sessionId },
        );
        const activeProposal =
          event.state === "awaiting_approval" && isPendingPlan(checkpoint)
            ? checkpoint
            : undefined;
        return {
          planningStates: {
            ...state.planningStates,
            [envelope.sessionId]: event.state,
          },
          planCheckpoints: checkpoint
            ? { ...state.planCheckpoints, [envelope.sessionId]: checkpoint }
            : state.planCheckpoints,
          pendingPlans: activeProposal
            ? { ...state.pendingPlans, [envelope.sessionId]: activeProposal }
            : withoutRecordKey(state.pendingPlans, envelope.sessionId),
        };
      });
      if (event.state === "awaiting_approval") {
        const checkpoint = get().planCheckpoints[envelope.sessionId];
        if (isPendingPlan(checkpoint)) {
          openPlanArtifact(checkpoint, get().openWorkPanelTabForSession);
        }
        void get().restorePendingPlan(envelope.sessionId);
        notifyInteractivePrompt(envelope.sessionId, "plan");
      }
      if (event.state !== "awaiting_approval") {
        void get().refreshQueuedPrompts(envelope.sessionId);
      }
    }
    // Any session's workspace mutation invalidates the review diff; this
    // must precede the cross-session early-return below.
    // Observe tool lifecycle events before the cross-session early return so
    // review artifacts remain scoped to their originating session.
    if (event.type === "tool_start") {
      if (toolStartsByCallId.size >= TOOL_NAME_CACHE_LIMIT) {
        const oldest = toolStartsByCallId.keys().next().value;
        if (oldest !== undefined) toolStartsByCallId.delete(oldest);
      }
      toolStartsByCallId.set(event.toolCallId, {
        toolName: event.toolName,
        args: event.args,
        createdAt: new Date(envelope.ts).toISOString(),
        ...(envelope.parentToolCallId
          ? { parentToolCallId: envelope.parentToolCallId }
          : {}),
        ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
      });
    } else if (event.type === "tool_end") {
      const toolName = toolStartsByCallId.get(event.toolCallId)?.toolName;
      set((state) => {
        const pendingPermissions = removePermissionForToolCall(
          state.pendingPermissions,
          envelope.sessionId,
          event.toolCallId,
        );
        const pendingAsks = removeAskForToolCall(
          state.pendingAsks,
          envelope.sessionId,
          event.toolCallId,
        );
        return pendingPermissions === state.pendingPermissions &&
          pendingAsks === state.pendingAsks
          ? {}
          : { pendingPermissions, pendingAsks };
      });
      const reviewArtifact = shouldOpenReviewArtifact({
        toolName,
        isError: event.isError,
        result: event.result,
      });
      if (reviewArtifact) {
        get().openWorkPanelTabForSession(
          envelope.sessionId,
          toolWorkPanelTab("review"),
        );
      }
    }
    // A checkpoint installs on whichever session produced it, active or not,
    // and its rows must survive until that session is next opened.
    if (event.type === "compaction_end" && event.ok && event.mark) {
      const mark = event.mark;
      set((state) => ({
        sessionCompactions: {
          ...state.sessionCompactions,
          [envelope.sessionId]: withCompactionMark(
            state.sessionCompactions[envelope.sessionId],
            mark,
          ),
        },
      }));
      void flushPendingSessionConfiguration(envelope.sessionId);
    }
    if (envelope.sessionId !== get().activeSessionId) {
      cacheBackgroundTranscriptEvent(envelope);
      // Cross-session events update only their scoped state. They never
      // replace the visible transcript, page, project, or focus.
      if (event.type === "tool_end") {
        toolStartsByCallId.delete(event.toolCallId);
      }
      if (event.type === "tool_permission_request") {
        set((state) => ({
          pendingPermissions: enqueuePermission(state.pendingPermissions, {
            ...event.request,
            receivedAt: envelope.ts,
          }),
        }));
        notifyInteractivePrompt(envelope.sessionId, "permission", {
          toolName: event.request.toolName,
        });
      } else if (event.type === "asktool_request") {
        set((state) => ({
          pendingAsks: enqueueAsk(state.pendingAsks, event.request),
        }));
        notifyInteractivePrompt(envelope.sessionId, "ask", {
          question: event.request.questions?.[0]?.question,
        });
      } else if (event.type === "agent_end") {
        void get().refreshSessions();
        void triggerAutoTitleSummarization(envelope.sessionId);
      } else if (event.type === "planning_state") {
        void get().refreshSessions();
      }
      return;
    }
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        set({ isRunning: true });
        break;
      case "compaction_start":
        set({ isRunning: true });
        break;
      case "compaction_end":
        if (event.reason === "manual") set({ isRunning: false });
        if (event.ok) {
          // Codex warns after every compaction, and so do we: each one drops
          // earlier detail, and the user is the only one who can decide to
          // start a fresh session instead. The other three toasts stay because
          // each says something more specific — a degraded checkpoint, a
          // request that overflowed, or a command they ran.
          get().showToast(i18n.t("contextCompaction.longThreadWarning"), {
            variant: "warning",
          });
          if (event.fallback) {
            get().showToast(i18n.t("contextCompaction.recovered"), {
              variant: "warning",
            });
          } else if (event.reason === "overflow") {
            get().showToast(i18n.t("contextCompaction.retrying"), {
              variant: "warning",
            });
          } else if (event.reason === "manual") {
            get().showToast(i18n.t("contextCompaction.completed"), {
              variant: "info",
            });
          }
        } else if (event.reason === "manual") {
          get().showToast(
            event.error?.message || i18n.t("contextCompaction.failed"),
            { variant: "error" },
          );
        }
        break;
      case "agent_end":
        set({ isRunning: false });
        void get().refreshSessions();
        void triggerAutoTitleSummarization(envelope.sessionId);
        break;
      case "turn_end":
        break;
      case "message_start":
        set((s) => {
          const exists = s.messages.some((m) => m.id === event.message.id);
          return exists
            ? s
            : { messages: [...s.messages, event.message] };
        });
        break;
      case "message_update":
        // Append when missing: switching back to a mid-stream session reloads
        // the persisted transcript, which doesn't yet contain the message
        // that is still streaming.
        set((s) => {
          const exists = s.messages.some((m) => m.id === event.message.id);
          return {
            messages: exists
              ? s.messages.map((m) =>
                  m.id === event.message.id ? event.message : m,
                )
              : [...s.messages, event.message],
          };
        });
        break;
      case "message_end":
        set((s) => {
          // Remove only legacy failures without structured detail and empty
          // aborts. Provider failures with AppError metadata are real
          // assistant transcript messages.
          if (
            event.message.role === "assistant" &&
            (event.message.status === "error" ||
              event.message.status === "aborted") &&
            !event.message.content.trim() &&
            !(event.message.thinking || "").trim() &&
            !event.message.error
          ) {
            return {
              messages: s.messages.filter((m) => m.id !== event.message.id),
            };
          }
          const exists = s.messages.some((m) => m.id === event.message.id);
          return {
            messages: exists
              ? s.messages.map((m) =>
                  m.id === event.message.id ? event.message : m,
                )
              : [...s.messages, event.message],
          };
        });
        break;
      case "tool_start":
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: event.toolCallId,
              role: "tool",
              content: "",
              createdAt: new Date(envelope.ts).toISOString(),
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              toolArgs: event.args,
              toolStatus: "running",
              status: "streaming",
              // Delegate rows are nested under their `Task` call rather than
              // added to the turn; the persisted row carries the same tags.
              ...(envelope.parentToolCallId
                ? { parentToolCallId: envelope.parentToolCallId }
                : {}),
              ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
            },
          ],
        }));
        break;
      case "tool_update":
        if (event.partialResult === undefined) break;
        set((s) => ({
          messages: s.messages.map((message) =>
            message.toolCallId === event.toolCallId &&
            message.toolStatus === "running"
              ? {
                  ...message,
                  content:
                    typeof event.partialResult === "string"
                      ? event.partialResult
                      : formatToolValue(event.partialResult),
                  toolResult: event.partialResult,
                }
              : message,
          ),
        }));
        break;
      case "tool_end":
        set((s) => {
          const toolStart = toolStartsByCallId.get(event.toolCallId);
          toolStartsByCallId.delete(event.toolCallId);
          const completedAt = new Date(envelope.ts).toISOString();
          const existing = s.messages.some(
            (message) => message.toolCallId === event.toolCallId,
          );
          const completed = {
            id: event.toolCallId,
            role: "tool" as const,
            content:
              typeof event.result === "string"
                ? event.result
                : JSON.stringify(event.result, null, 2),
            createdAt: toolStart?.createdAt ?? completedAt,
            toolCallId: event.toolCallId,
            ...(toolStart?.toolName
              ? { toolName: toolStart.toolName }
              : {}),
            ...(toolStart ? { toolArgs: toolStart.args } : {}),
            ...(toolStart?.parentToolCallId
              ? { parentToolCallId: toolStart.parentToolCallId }
              : {}),
            ...(toolStart?.agentName ? { agentName: toolStart.agentName } : {}),
            toolCompletedAt: completedAt,
            toolDurationMs: toolStart
              ? Math.max(0, envelope.ts - Date.parse(toolStart.createdAt))
              : 0,
            toolStatus: event.isError ? ("error" as const) : ("success" as const),
            toolResult: event.result,
            ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
            status: "complete" as const,
            isError: event.isError,
          } satisfies UiMessage;
          return {
            messages: existing
              ? s.messages.map((message) =>
                  message.toolCallId === event.toolCallId
                    ? {
                        ...message,
                        ...completed,
                        toolName: message.toolName ?? completed.toolName,
                        toolArgs: message.toolArgs ?? completed.toolArgs,
                        createdAt: message.createdAt || completed.createdAt,
                      }
                    : message,
                )
              : [...s.messages, completed],
          };
        });
        break;
      case "tool_permission_request":
        set((state) => ({
          pendingPermissions: enqueuePermission(state.pendingPermissions, {
            ...event.request,
            receivedAt: envelope.ts,
          }),
        }));
        notifyInteractivePrompt(envelope.sessionId, "permission", {
          toolName: event.request.toolName,
        });
        break;
      case "asktool_request":
        set((state) => ({
          pendingAsks: enqueueAsk(state.pendingAsks, event.request),
        }));
        notifyInteractivePrompt(envelope.sessionId, "ask", {
          question: event.request.questions?.[0]?.question,
        });
        break;
      case "error": {
        // A user-initiated stop is not an error; just settle the run state.
        const aborted = event.error.code === "TURN_ABORTED";
        set((s) => {
          const last = s.messages[s.messages.length - 1];
          const hasErrorMessage =
            last?.role === "assistant" &&
            (last.status === "error" || last.isError === true);
          const messages: UiMessage[] = s.messages
            // A turn that died before producing text leaves an empty
            // aborted bubble. Provider failures stay as assistant messages.
            .filter(
              (message) =>
                !(
                  message.role === "assistant" &&
                  message.status === "aborted" &&
                  !message.content.trim() &&
                  !(message.thinking || "").trim()
                ),
            )
            .map((message) =>
              message.role === "tool" && message.toolStatus === "running"
                ? {
                    ...message,
                    toolStatus: "error" as const,
                    status: "error" as const,
                    isError: true,
                  }
                : message.role === "assistant" &&
                    message.status === "streaming"
                  ? {
                      ...message,
                      status: aborted ? ("aborted" as const) : ("error" as const),
                    }
                  : message,
            );
          return {
            isRunning: false,
            error: null,
            errorCode: null,
            errorRetriable: null,
            messages:
              aborted || hasErrorMessage
                ? messages
                : [...messages, assistantErrorMessage(event.error)],
          };
        });
        break;
      }
      default:
        break;
    }
  },

  setPage: (page, opts) => {
    beginNavigationIntent();
    const record = opts?.record !== false;
    set((s) => {
      if (!record) return { page };
      const entry = {
        page,
        sessionId: page === "chat" ? s.activeSessionId : undefined,
      };
      const stack = s.navStack.slice(0, s.navIndex + 1);
      const last = stack[stack.length - 1];
      const same =
        last?.page === entry.page && last?.sessionId === entry.sessionId;
      const nextStack = same ? stack : [...stack, entry].slice(-50);
      return {
        page,
        navStack: nextStack,
        navIndex: nextStack.length - 1,
      };
    });
  },
  setSettingsTab: (settingsTab) => {
    get().setPage("settings");
    set({ settingsTab });
  },
  setSettingsAnchor: (settingsAnchor) => set({ settingsAnchor }),
  canNavBack: () => get().navIndex > 0,
  canNavForward: () => get().navIndex < get().navStack.length - 1,
  navBack: () => {
    const intent = beginNavigationIntent();
    const s = get();
    if (s.navIndex <= 0) return;
    const idx = s.navIndex - 1;
    const entry = s.navStack[idx];
    set({ navIndex: idx, page: entry.page });
    if (entry.page === "chat" && entry.sessionId) {
      void get().selectSession(entry.sessionId, {
        record: false,
        navigationIntent: intent,
      });
      set({ navIndex: idx });
    }
  },
  navForward: () => {
    const intent = beginNavigationIntent();
    const s = get();
    if (s.navIndex >= s.navStack.length - 1) return;
    const idx = s.navIndex + 1;
    const entry = s.navStack[idx];
    set({ navIndex: idx, page: entry.page });
    if (entry.page === "chat" && entry.sessionId) {
      void get().selectSession(entry.sessionId, {
        record: false,
        navigationIntent: intent,
      });
      set({ navIndex: idx });
    }
  },
  resolvePermission: async (sessionId, requestId, decision) => {
    // Only the head request is on screen, so only the head request is
    // answerable; the rest keep waiting their turn.
    const permission = headPermission(get().pendingPermissions, sessionId);
    if (!permission || permission.requestId !== requestId) return;
    try {
      await api.resolvePermission({
        requestId,
        decision,
      });
    } finally {
      // A late response for an expired request must not clear its successor.
      set((state) => ({
        pendingPermissions: removePermission(
          state.pendingPermissions,
          sessionId,
          requestId,
        ),
      }));
    }
  },
  resolveAsk: async (sessionId, resolution) => {
    const ask = headAsk(get().pendingAsks, sessionId);
    if (!ask || ask.requestId !== resolution.requestId) return;
    try {
      await api.resolveAskTool(resolution);
    } finally {
      set((state) => ({
        pendingAsks: removeAsk(state.pendingAsks, sessionId, resolution.requestId),
      }));
    }
  },
  resolvePlan: async (resolution) => {
    const activeRequest = planResolutionRequests.get(resolution.proposalId);
    if (activeRequest) return activeRequest;
    const pending = get().pendingPlans[resolution.sessionId];
    if (!pending || pending.status !== "pending" || pending.id !== resolution.proposalId) {
      throw new Error(i18n.t("errors.planApprovalUnavailable"));
    }
    const request = (async () => {
      try {
        const result = await api.resolvePlan(resolution);
        // The response is authoritative host success. The matching
        // plans.changed event is also accepted by handlePlansChanged; neither
        // path clears a proposal before the host has confirmed the action.
        get().handlePlansChanged({
          sessionId: resolution.sessionId,
          state: result.state,
          proposal: result.proposal,
          proposalId: result.proposal.id,
          action: result.action,
          targetPermissionMode: result.targetPermissionMode,
        });
        return result;
      } catch (error) {
        if (
          (error as { code?: unknown })?.code ===
          ErrorCodes.PLAN_APPROVAL_TIMEOUT
        ) {
          await get().restorePendingPlan(resolution.sessionId);
        }
        throw error;
      }
    })();
    planResolutionRequests.set(resolution.proposalId, request);
    try {
      return await request;
    } finally {
      if (planResolutionRequests.get(resolution.proposalId) === request) {
        planResolutionRequests.delete(resolution.proposalId);
      }
    }
  },
  showToast: (message, options) => {
    const variant = options?.variant ?? "info";
    const duration =
      options?.duration ??
      (variant === "error" ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS);
    set((state) => {
      // Re-raising an identical toast restarts it instead of stacking a twin.
      const kept = state.toasts.filter(
        (item) => item.message !== message || item.variant !== variant,
      );
      const next = [...kept, { id: ++toastSeq, message, variant, duration }];
      return { toasts: next.slice(-TOAST_STACK_LIMIT) };
    });
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),

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
    liveSessionTranscripts.add(id);
  }
  cacheSessionTranscript(id, state.messages, state.sessionHistory[id]);
  if (state.retainedTranscripts[id] === state.messages) return;
  useAppStore.setState((current) =>
    current.activeSessionId === id
      ? recordPaneTranscript(current, id, current.messages)
      : {},
  );
});

function flushPendingSessionConfiguration(sessionId: string): Promise<void> {
  const active = sessionConfigurationFlushes.get(sessionId);
  if (active) return active;
  if (useAppStore.getState().runningSessions[sessionId]) {
    return Promise.resolve();
  }

  const flush = (async () => {
    let failed = false;
    while (!useAppStore.getState().runningSessions[sessionId]) {
      const config = pendingSessionConfigurations.get(sessionId);
      if (!config) break;
      try {
        const result = await api.configureSession(sessionId, config);
        // The entry stays staged until the host accepts it. A choice staged
        // while the call was in flight has already merged into a newer entry,
        // which the next iteration sends.
        if (pendingSessionConfigurations.get(sessionId) === config) {
          pendingSessionConfigurations.delete(sessionId);
        }
        useAppStore.setState((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...result.session,
                  pinned: sessionIsPinned(sessionId, state.sessionMeta),
                  archived: sessionIsArchived(sessionId, state.sessionMeta),
                }
              : session,
          ),
          planningStates: {
            ...state.planningStates,
            [sessionId]:
              result.session.mode === "plan" ? "planning" : "inactive",
          },
        }));
      } catch (error) {
        useAppStore.getState().showToast(
          error instanceof Error ? error.message : String(error),
          { variant: "error" },
        );
        void useAppStore.getState().refreshSessions();
        // A newer entry replaced the rejected one mid-flight: send that one.
        // Otherwise the staged choice is kept for the next flush trigger
        // instead of being retried blind here.
        if (pendingSessionConfigurations.get(sessionId) !== config) continue;
        failed = true;
        break;
      }
    }
    return failed;
  })();
  const settled = flush.then(() => undefined);
  sessionConfigurationFlushes.set(sessionId, settled);
  void flush.then((failed) => {
    if (sessionConfigurationFlushes.get(sessionId) === settled) {
      sessionConfigurationFlushes.delete(sessionId);
    }
    if (
      !failed &&
      pendingSessionConfigurations.has(sessionId) &&
      !useAppStore.getState().runningSessions[sessionId]
    ) {
      void flushPendingSessionConfiguration(sessionId);
    }
  });
  return settled;
}

type PersistSessionOptions = {
  intent?: number;
  projectPath?: string | null;
  draftConfiguration?: DraftSessionConfiguration | null;
};

/**
 * Drop the previous transcript on this frame so New Task does not leave the
 * old conversation on screen while `session.create` is in flight (D305).
 */
function revealEmptyCreatingSession(intent: number): void {
  if (!navigationIntentIsCurrent(intent)) return;
  useAppStore.setState((state) => {
    if (
      !state.activeSessionId &&
      state.page === "chat" &&
      state.messages.length === 0 &&
      state.retainedSessionIds.length === 0
    ) {
      return {};
    }
    return {
      ...switchWorkPanelSession(state, undefined),
      ...clearSessionPanes(),
      activeSessionId: undefined,
      selectingSessionId: undefined,
      messages: [],
      page: "chat" as const,
      isRunning: false,
    };
  });
}

function commitCreatedEmptySession(
  summary: SessionSummary,
  options: { activate: boolean },
): void {
  const messages: UiMessage[] = [];
  cacheSessionTranscript(summary.id, messages, EMPTY_SESSION_WINDOW);
  if (options.activate) scheduleHomeDraftAdopt(summary.id);
  useAppStore.setState((current) => {
    const commit = commitForkedSessionState(current, summary, {
      activate: options.activate,
    });
    const shared: Partial<AppState> = {
      sessions: decorateSessions(commit.sessions, current.sessionMeta),
      sessionHistory: {
        ...current.sessionHistory,
        [summary.id]: EMPTY_SESSION_WINDOW,
      },
      planningStates: {
        ...current.planningStates,
        [summary.id]: summary.mode === "plan" ? "planning" : "inactive",
      },
    };
    if (!commit.activated) return shared;
    return {
      ...switchWorkPanelSession(current, summary.id),
      ...shared,
      ...retainSessionPane(current, summary.id, messages),
      activeSessionId: summary.id,
      selectingSessionId: undefined,
      draftConfiguration: null,
      messages,
      page: "chat" as const,
      // The composer follows the visible session's own run state: a turn
      // still streaming in the previously selected session must not leave
      // the fresh session's send button stuck in the stop/abort state
      // (the old session's agent_end is a cross-session event and never
      // clears the active flag).
      isRunning: current.runningSessions[summary.id] ?? false,
      navStack: commit.navStack as AppState["navStack"],
      navIndex: commit.navIndex,
    };
  });
}

/**
 * Create a durable empty session and select it. The same path is used by an
 * explicit New Task click and by the legacy home draft when its first message
 * or pasted file needs a session. Returns null when navigation was superseded
 * after the host mutation; the created row is still inserted into the list.
 */
async function persistSessionAndSelect(
  options: PersistSessionOptions = {},
): Promise<string | null> {
  const active = options.intent ?? beginNavigationIntent();
  const state = useAppStore.getState();
  const settings = state.settings;
  // No providerId/modelId here unless the user pinned a pick on the draft:
  // sessions without an explicit pick resolve them at prompt time, so later
  // default-model changes apply everywhere. The Composer pins both onto the
  // session when the user chooses a model.
  const projectPath =
    options && "projectPath" in options
      ? options.projectPath
      : state.workspace?.path ?? null;
  const draftConfig =
    options && "draftConfiguration" in options
      ? options.draftConfiguration
      : state.draftConfiguration;
  const defaultProvider = state.providers.find(
    (provider) =>
      provider.id === (draftConfig?.providerId ?? settings?.defaultProviderId),
  );
  const inheritedModelId =
    draftConfig?.modelId ??
    settings?.defaultModelId ??
    defaultProvider?.defaultModelId;
  const inheritedBinding = defaultProvider?.models.find((candidate) =>
    modelIdsMatch(candidate.id, inheritedModelId ?? ""),
  );
  // New reasoning sessions start at the selected model's stored default
  // thinking level, clamped onto the enabled ladder. Catalog metadata seeds
  // that default when the model is added; strongest-enabled is only the
  // fallback when Settings has not stored a default.
  const defaultThinkingLevel = initialThinkingLevelForBinding(
    inheritedBinding,
    defaultProvider?.supportedThinkingLevels,
  );
  const previousSessionId = state.activeSessionId;
  revealEmptyCreatingSession(active);
  let created: Awaited<ReturnType<typeof api.createSession>>;
  try {
    created = await api.createSession({
      title: untitledTaskTitle(),
      mode: draftConfig?.mode ?? normalizeMode(settings?.defaultMode),
      thinkingLevel: draftConfig?.thinkingLevel ?? defaultThinkingLevel,
      permissionMode: draftConfig?.permissionMode,
      providerId: draftConfig?.providerId,
      modelId: draftConfig?.modelId,
      projectPath: projectPath ?? undefined,
    });
  } catch (error) {
    if (previousSessionId && navigationIntentIsCurrent(active)) {
      void useAppStore.getState().selectSession(previousSessionId, {
        navigationIntent: active,
      });
    }
    throw error;
  }
  const sessionId = created.session.id;
  if (!navigationIntentIsCurrent(active)) {
    commitCreatedEmptySession(created.session, { activate: false });
    return null;
  }
  commitCreatedEmptySession(created.session, { activate: true });
  return sessionId;
}

/**
 * Materialize the home draft when it receives its first real input. Explicit
 * New Task actions call `persistSessionAndSelect` directly so they can reuse
 * the most recent empty session in their requested project scope.
 */
export async function materializeDraftSession(
  intent?: number,
): Promise<string | null> {
  const state = useAppStore.getState();
  const scopeKey = newSessionScopeKey(state.workspace?.path ?? null);
  const pending = pendingNewSessionRequests.get(scopeKey);
  if (pending) {
    await pending;
    const activeId = useAppStore.getState().activeSessionId;
    if (activeId) return activeId;
  }
  return persistSessionAndSelect({ intent });
}
