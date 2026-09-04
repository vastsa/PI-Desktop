import { create } from "zustand";
import i18n from "i18next";
import type {
  AgentEventEnvelope,
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
import { rememberProject, setProjectPinned } from "../lib/recent-projects";
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
  activateWorkPanelTabState,
  closeWorkPanelTabState,
  emptyWorkPanelContext,
  fileWorkPanelTab,
  openWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  shouldOpenReviewArtifact,
  switchWorkPanelContextState,
  toolWorkPanelTab,
  type WorkPanelContext,
  type WorkPanelTab,
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

const ErrorCodes = {
  ...SharedErrorCodes,
  PLAN_APPROVAL_TIMEOUT: "PLAN_APPROVAL_TIMEOUT",
} as const;

export type { WorkPanelTab } from "../lib/work-panel-tabs";

function promptAttachmentsFromDraft(
  references: ComposerDraftSnapshot["fileReferences"],
): AgentPromptAttachment[] {
  return references
    .filter((reference) => !reference.token)
    .map((reference) => ({
      path: reference.path,
      name: reference.name,
      kind:
        reference.kind ??
        (/\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(reference.path)
          ? "image"
          : "file"),
      ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
    }));
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

export type ToastVariant = "info" | "success" | "warning" | "error";

export type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss delay in ms; 0 keeps the toast until dismissed. */
  duration: number;
};

export type ToastOptions = {
  variant?: ToastVariant;
  /** Override the variant default (4s, error 8s); 0 disables auto-dismiss. */
  duration?: number;
};

export type AgentTurnResult = {
  status: "completed" | "failed";
  turnId: string;
  finishedAt: number;
  errorCode?: string;
};
export type PendingPlanRefreshResult = "pending" | "terminal" | "unavailable";

const WORK_PANEL_STORAGE_KEY = "pi.desktop.workPanel";
const SESSION_TRANSCRIPT_CACHE_LIMIT = 20;
export const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
export const SESSION_TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;
export { RETAINED_SESSION_PANE_LIMIT };
// Preserve the original 320px tool-content minimum beside the 44px activity rail.
export { WORK_PANEL_DEFAULT_WIDTH, WORK_PANEL_MIN_WIDTH };

let workPanelFileRequestSeq = 0;
const navigationIntents = createNavigationIntentController();
let pendingSessionSelection: { id: string; intent: number } | null = null;
let sessionWorkspaceQueue: Promise<void> = Promise.resolve();
const pendingNewSessionRequests = new Map<string, Promise<void>>();
const sessionTranscriptCache = new Map<string, UiMessage[]>();
// A cache entry can contain a completed row that is newer than the durable
// read, so keep its live provenance until a selection has reconciled it.
const liveSessionTranscripts = new Set<string>();
type SessionHistoryWindow = {
  messageStart: number;
  hasMoreBefore: boolean;
};
const sessionHistoryCache = new Map<string, SessionHistoryWindow>();
const planResolutionRequests = new Map<string, Promise<PlanResolutionResult>>();
const planSyncGenerations = new Map<string, number>();
type SubmittedComposerDraft = {
  messageCountBeforeSend: number;
  draft: ComposerDraftSnapshot;
  abortResolution?: Promise<boolean>;
  resolveAbort?: (restored: boolean) => void;
};
const submittedComposerDrafts = new Map<string, SubmittedComposerDraft>();
type SessionConfiguration = Pick<
  SessionSummary,
  "mode" | "providerId" | "modelId" | "thinkingLevel"
> &
  Partial<Pick<SessionSummary, "permissionMode">>;
/**
 * The host pins one configuration for an active turn. Composer changes made
 * while that turn runs are optimistic next-turn choices and flush once the
 * durable turn reaches a terminal event.
 */
const pendingSessionConfigurations = new Map<string, SessionConfiguration>();
const sessionConfigurationFlushes = new Map<string, Promise<void>>();
const queuedPromptDrains = new Map<string, Promise<void>>();
const sessionDetailLoads = new Map<
  string,
  ReturnType<typeof api.getSession>
>();
const sessionOlderLoads = new Map<string, Promise<void>>();

type NavigationOptions = {
  /** Reuse an owning navigation's generation across nested async operations. */
  navigationIntent?: number;
};

function beginNavigationIntent() {
  return navigationIntents.begin();
}

function navigationIntentIsCurrent(intent: number) {
  return navigationIntents.isCurrent(intent);
}

function newSessionScopeKey(projectPath?: string | null): string {
  return normalizeProjectPath(projectPath) ?? "<temporary>";
}

function latestSessionInScope(
  sessions: SessionSummary[],
  projectPath: string | null,
  sessionMeta: Record<string, SessionMeta>,
): SessionSummary | undefined {
  return sessions
    .filter((session) => sessionMatchesProject(session, projectPath))
    .sort((a, b) => {
      const aUpdated = Date.parse(a.updatedAt);
      const bUpdated = Date.parse(b.updatedAt);
      const aTime = Number.isFinite(aUpdated) ? aUpdated : 0;
      const bTime = Number.isFinite(bUpdated) ? bUpdated : 0;
      return bTime - aTime || b.id.localeCompare(a.id);
    })
    .find((session) => !sessionIsArchived(session.id, sessionMeta));
}

function liveMessageCountForSession(
  id: string,
  state: { activeSessionId?: string; messages: UiMessage[]; retainedTranscripts: Record<string, UiMessage[]> },
): number {
  if (state.activeSessionId === id) return state.messages.length;
  return (
    sessionTranscriptCache.get(id)?.length ??
    state.retainedTranscripts[id]?.length ??
    0
  );
}

function cacheSessionTranscript(
  id: string,
  messages: UiMessage[],
  window?: SessionHistoryWindow,
) {
  const normalized = dedupeSessionMessages(messages);
  sessionTranscriptCache.delete(id);
  sessionTranscriptCache.set(id, normalized);
  if (window) sessionHistoryCache.set(id, window);
  while (sessionTranscriptCache.size > SESSION_TRANSCRIPT_CACHE_LIMIT) {
    const oldestId = sessionTranscriptCache.keys().next().value;
    if (typeof oldestId !== "string") break;
    sessionTranscriptCache.delete(oldestId);
    sessionHistoryCache.delete(oldestId);
    liveSessionTranscripts.delete(oldestId);
  }
}

function loadSessionDetail(
  id: string,
  options?: {
    messageBefore?: number;
    messageLimit?: number;
    contentLimit?: number;
  },
) {
  const active = sessionDetailLoads.get(id);
  if (active && options?.messageBefore === undefined) return active;
  const request = api.getSession(id, options).then((detail) => {
    if (detail.session && options?.messageBefore === undefined) {
      const state = useAppStore.getState();
      const liveMessages =
        sessionTranscriptCache.get(id) ?? state.retainedTranscripts[id];
      const messages =
        (liveSessionTranscripts.has(id) || state.runningSessions[id]) &&
        liveMessages
          ? mergeLiveSessionMessages(detail.session.messages ?? [], liveMessages)
          : detail.session.messages ?? [];
      cacheSessionTranscript(id, messages, {
        messageStart: detail.session.messageStart ?? 0,
        hasMoreBefore: detail.session.hasMoreBefore === true,
      });
    }
    return detail;
  });
  if (options?.messageBefore === undefined) sessionDetailLoads.set(id, request);
  const clear = () => {
    if (
      options?.messageBefore === undefined &&
      sessionDetailLoads.get(id) === request
    ) {
      sessionDetailLoads.delete(id);
    }
  };
  void request.then(clear, clear);
  return request;
}

async function loadFullSessionMessages(id: string): Promise<UiMessage[] | null> {
  const detail = await api.getSession(id);
  if (!detail.session) return null;
  const messages = detail.session.messages ?? [];
  cacheSessionTranscript(id, messages, { messageStart: 0, hasMoreBefore: false });
  return messages;
}

/**
 * Show the user's prompt the moment it is sent (D288). The visible session
 * appends the row to its transcript; a background session receives it through
 * its renderer cache, exactly where the host echo will land.
 */
function insertOptimisticUserMessage(sessionId: string, message: UiMessage): void {
  const state = useAppStore.getState();
  if (state.activeSessionId === sessionId) {
    useAppStore.setState((s) => ({
      messages: upsertLiveSessionMessage(s.messages, message),
    }));
    return;
  }
  const cached = sessionTranscriptCache.get(sessionId);
  if (cached) {
    sessionTranscriptCache.set(sessionId, upsertLiveSessionMessage(cached, message));
  }
}

/**
 * Undo the optimistic row when the send never reached the host. Only the
 * renderer's own object is removed: once the host has echoed the durable row
 * under the same id the failure happened after persistence, and the row stays.
 */
function retractOptimisticUserMessage(sessionId: string, message: UiMessage): void {
  const state = useAppStore.getState();
  if (state.activeSessionId === sessionId) {
    useAppStore.setState((s) =>
      s.messages.includes(message)
        ? { messages: removeLiveSessionMessage(s.messages, message.id) }
        : s,
    );
    return;
  }
  const cached = sessionTranscriptCache.get(sessionId);
  if (cached?.includes(message)) {
    sessionTranscriptCache.set(sessionId, removeLiveSessionMessage(cached, message.id));
  }
}

/**
 * Keep a warm session's renderer cache current while it streams in the
 * background. The hidden pane itself is not re-rendered; its next reveal reads
 * this cache and commits the latest available tail in one frame.
 */
function cacheBackgroundTranscriptEvent(envelope: AgentEventEnvelope): void {
  const { sessionId, event } = envelope;
  const state = useAppStore.getState();
  const current =
    sessionTranscriptCache.get(sessionId) ?? state.retainedTranscripts[sessionId];
  if (!current) return;

  let next = current;
  switch (event.type) {
    case "message_start":
    case "message_update":
      next = upsertLiveSessionMessage(current, event.message);
      break;
    case "message_end": {
      const failed =
        event.message.status === "error" || event.message.status === "aborted";
      const empty =
        !(event.message.content || "").trim() &&
        !(event.message.thinking || "").trim();
      next =
        failed && empty && !event.message.error
          ? removeLiveSessionMessage(current, event.message.id)
          : upsertLiveSessionMessage(current, event.message);
      break;
    }
    case "tool_start":
      next = upsertLiveSessionMessage(current, {
        id: event.toolCallId,
        role: "tool",
        content: "",
        createdAt: new Date(envelope.ts).toISOString(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolArgs: event.args,
        toolStatus: "running",
        status: "streaming",
        ...(envelope.parentToolCallId
          ? { parentToolCallId: envelope.parentToolCallId }
          : {}),
        ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
      });
      break;
    case "tool_update": {
      if (event.partialResult === undefined) return;
      const existing = current.find(
        (message) =>
          message.toolCallId === event.toolCallId &&
          message.toolStatus === "running",
      );
      if (!existing) return;
      next = upsertLiveSessionMessage(current, {
        ...existing,
        content:
          typeof event.partialResult === "string"
            ? event.partialResult
            : formatToolValue(event.partialResult),
        toolResult: event.partialResult,
      });
      break;
    }
    case "tool_end": {
      const toolStart = toolStartsByCallId.get(event.toolCallId);
      const completedAt = new Date(envelope.ts).toISOString();
      const completed: UiMessage = {
        id: event.toolCallId,
        role: "tool",
        content:
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result, null, 2),
        createdAt: toolStart?.createdAt ?? completedAt,
        toolCallId: event.toolCallId,
        ...(toolStart?.toolName ? { toolName: toolStart.toolName } : {}),
        ...(toolStart ? { toolArgs: toolStart.args } : {}),
        toolCompletedAt: completedAt,
        toolDurationMs: toolStart
          ? Math.max(0, envelope.ts - Date.parse(toolStart.createdAt))
          : 0,
        toolStatus: event.isError ? "error" : "success",
        toolResult: event.result,
        ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
        status: "complete",
        isError: event.isError,
      };
      const existing = current.find(
        (message) => message.toolCallId === event.toolCallId,
      );
      next = existing
        ? upsertLiveSessionMessage(current, {
            ...existing,
            ...completed,
            toolName: existing.toolName ?? completed.toolName,
            toolArgs: existing.toolArgs ?? completed.toolArgs,
            createdAt: existing.createdAt || completed.createdAt,
          })
        : upsertLiveSessionMessage(current, completed);
      break;
    }
    default:
      return;
  }

  if (next === current) return;
  liveSessionTranscripts.add(sessionId);
  cacheSessionTranscript(
    sessionId,
    next,
    sessionHistoryCache.get(sessionId) ?? state.sessionHistory[sessionId],
  );
}

function nextPlanSyncGeneration(sessionId: string): number {
  const next = (planSyncGenerations.get(sessionId) ?? 0) + 1;
  planSyncGenerations.set(sessionId, next);
  return next;
}

function planSyncGeneration(sessionId: string): number {
  return planSyncGenerations.get(sessionId) ?? 0;
}

/**
 * Projected planning state plus the contract kind decide the durable mode a
 * session is shown in: Plan and Goal both project `planning` (D198).
 */
function sessionModeForPlanningState(
  state: PlanningState,
  kind: ProposalKind | undefined,
): Mode {
  if (state === "inactive") return "agent";
  return modeForProposalKind(kind ?? "plan");
}

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

function loadWorkPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WORK_PANEL_STORAGE_KEY);
    if (!raw) return WORK_PANEL_DEFAULT_WIDTH;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const width = Number(parsed.width);
    return Number.isFinite(width)
      ? Math.max(
          WORK_PANEL_MIN_WIDTH,
          Math.min(WORK_PANEL_MAX_WIDTH, Math.round(width)),
        )
      : WORK_PANEL_DEFAULT_WIDTH;
  } catch {
    return WORK_PANEL_DEFAULT_WIDTH;
  }
}

function saveWorkPanelWidth(width: number) {
  try {
    localStorage.setItem(
      WORK_PANEL_STORAGE_KEY,
      JSON.stringify({ width }),
    );
  } catch {
    // best-effort persistence
  }
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

export type SessionView = {
  sort: SessionSort;
  /** Alias retained for sidebar consumers that use the explicit name. */
  sortBy?: SessionSort;
  /** Whether archived sessions are included in sidebar queries. */
  archived: boolean;
  showArchived?: boolean;
};

/** Toolbar selections made on the unpersisted new-task draft. They are
 * applied when the first message materializes the draft into a session
 * instead of creating a history row for a toolbar-only interaction. */
export type DraftSessionConfiguration = {
  mode: Mode;
  thinkingLevel: ThinkingLevel;
  providerId?: string;
  modelId?: string;
  permissionMode?: PermissionMode;
};

export type AppState = {
  ready: boolean;
  version?: AppVersionInfo;
  healthOk: boolean;
  settings?: AppSettings;
  sessions: SessionSummary[];
  /** Renderer-owned conversation presentation metadata. */
  sessionMeta: Record<string, SessionMeta>;
  sessionView: SessionView;
  /** Open project tabs and the host's currently active workspace. */
  openProjects: ProjectWorkspace[];
  openProjectPaths: string[];
  activeProjectPath?: string;
  projectMeta: Record<string, ProjectMeta>;
  /** Kept as a flat map for lightweight consumers (Sidebar). */
  projectCollapsed: Record<string, boolean>;
  projectSort: ProjectSort;
  activeSessionId?: string;
  /** Composer toolbar choices retained on the draft while it has no session
   * yet; cleared once the draft is materialized into a session. */
  draftConfiguration: DraftSessionConfiguration | null;
  /** Latest user-selected session while its transcript/workspace is resolving. */
  selectingSessionId?: string;
  messages: UiMessage[];
  /**
   * Session ids whose panes stay mounted, most recently visible first and
   * bounded by `RETAINED_SESSION_PANE_LIMIT` (ADR 0137). The head is the
   * session the chat surface shows.
   */
  retainedSessionIds: string[];
  /**
   * Last transcript each retained pane painted. A pane reads the live
   * `messages` projection while it owns the active session and falls back to
   * this snapshot once another session takes over, so leaving a session cannot
   * blank the pane the user is coming back to.
   */
  retainedTranscripts: Record<string, UiMessage[]>;
  /** Renderer-owned range metadata for the lazily loaded active transcript. */
  sessionHistory: Record<string, SessionHistoryWindow>;
  isRunning: boolean;
  /** Run state per session id — sessions run independent agents. */
  runningSessions: Record<string, boolean>;
  /** Latest in-memory result for each session, used by the active transcript. */
  latestTurnResults: Record<string, AgentTurnResult>;
  /** Latest terminal outcome per session for compact sidebar feedback. */
  sessionOutcomes: Record<string, SidebarSessionOutcome>;
  /**
   * Every checkpoint a session has installed, oldest first. The transcript
   * renders one divider row each and the context inspector reads the last one.
   */
  sessionCompactions: Record<string, ContextCompactionMark[]>;
  providers: ProviderPublic[];
  /** Discovered model lists per provider id (composer model menu). */
  providerModels: Record<string, ModelInfo[]>;
  workspace?: ProjectWorkspace | null;
  onboarding?: OnboardingState;
  plugins: PluginSummary[];
  /** Themes contributed by loaded plugins, with their sanitized CSS. */
  pluginThemes: PluginTheme[];
  /** Work panel views contributed by loaded plugins, in menu order. */
  pluginViews: PluginViewMeta[];
  /** Per-session permission queue, oldest first; parallel delegates can each
   * be waiting on one (ADR 0062). */
  pendingPermissions: PermissionQueues;
  /** Inline asktool requests, queued per session without an expiry. */
  pendingAsks: AskQueues;
  /** Renderer-owned, in-memory prompt queue, isolated by session. */
  queuedPrompts: QueuedPrompts;
  /** Planning state is durable per session, including sessions outside view. */
  planningStates: Record<string, PlanningState>;
  /** Live host approval rows keyed by session; only pending rows form the gate. */
  pendingPlans: Record<string, PlanProposal>;
  /** Latest immutable Plan checkpoint/execution snapshot per session. */
  planCheckpoints: Record<string, PlanProposal>;
  toasts: ToastItem[];
  notifications: AppNotification[];
  unreadNotificationCount: number;
  page: "chat" | "pulls" | "scheduled" | "plugins" | "settings";
  /** Tab ids come from the shared settings index so nav, search, and the
   * page cannot drift apart. */
  settingsTab: SettingsTabId;
  /** Pending row anchor (i18n key) to flash after landing on a settings tab. */
  settingsAnchor: string | null;
  navStack: Array<{ page: AppState["page"]; sessionId?: string }>;
  navIndex: number;
  error?: string | null;
  errorCode?: string | null;
  /** Whether the current error is worth a one-click retry (agent errors). */
  errorRetriable?: boolean | null;
  bootstrap: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  prefetchSession: (id: string) => Promise<void>;
  loadOlderMessages: (sessionId: string) => Promise<void>;
  selectSession: (
    id: string,
    opts?: { record?: boolean } & NavigationOptions,
  ) => Promise<void>;
  newSession: (options?: { projectPath?: string | null }) => Promise<void>;
  forkSession: (id: string) => Promise<void>;
  forkAssistantMessage: (messageId: string) => Promise<void>;
  configureActiveSession: (config: {
    mode: Mode;
    providerId?: string;
    modelId?: string;
    thinkingLevel: ThinkingLevel;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  /** Returns true once accepted unless concurrent smart Stop restores it. */
  sendPrompt: (
    content: string,
    draft?: ComposerDraftSnapshot,
    targetSessionId?: string,
  ) => Promise<boolean>;
  enqueuePrompt: (
    content: string,
    draft?: ComposerDraftSnapshot,
    sessionId?: string,
  ) => void;
  removeQueuedPrompt: (promptId: string) => void;
  sendQueuedNow: (promptId: string) => Promise<void>;
  compactContext: () => Promise<void>;
  retryAssistantMessage: (messageId: string) => Promise<void>;
  /** Replace a user prompt and regenerate from it; the old branch stays in the revision pager. */
  editUserMessage: (
    messageId: string,
    content: string,
    attachments?: UiMessage["attachments"],
  ) => Promise<boolean>;
  retryLastPrompt: () => Promise<void>;
  clearError: () => void;
  activateMessageRevision: (rootUserId: string, revisionIndex: number) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  rollbackWorkspaceChange: (
    messageId: string,
    snapshotId: string,
  ) => Promise<ReviewRollbackResult | null>;
  abort: () => Promise<void>;
  openProject: () => Promise<void>;
  activateProject: (
    path: string,
    opts?: NavigationOptions,
  ) => Promise<ProjectWorkspace | null>;
  openProjectPath: (path: string) => Promise<ProjectWorkspace | null>;
  switchProjectPath: (path: string) => Promise<ProjectWorkspace | null>;
  closeProjectPath: (path: string) => Promise<void>;
  clearProject: (opts?: NavigationOptions) => Promise<void>;
  toggleSessionPinned: (id: string) => void;
  toggleSessionArchived: (id: string) => void;
  archiveSession: (id: string) => void;
  restoreSession: (id: string) => void;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setSessionSort: (sort: SessionSort) => void;
  setSessionArchiveVisibility: (show: boolean) => void;
  setSessionView: (view: Partial<SessionView> | boolean) => void;
  setShowArchived: (show: boolean) => void;
  toggleProjectPinned: (path: string, pinned?: boolean) => void;
  toggleProjectArchived: (path: string) => void;
  restoreProject: (path: string) => void;
  archiveProject: (path: string) => void;
  setProjectCollapsed: (path: string, collapsed?: boolean) => void;
  toggleProjectCollapsed: (path: string) => void;
  closeProject: (path: string) => Promise<void>;
  setProjectSort: (sort: ProjectSort) => void;
  getVisibleSessions: (options?: {
    projectPath?: string | null;
    includeArchived?: boolean;
  }) => SessionSummary[];
  getSortedProjects: () => ProjectWorkspace[];
  refreshProviders: () => Promise<void>;
  /** Load a provider's model list into the cache (no-op when cached). */
  loadProviderModels: (providerId: string) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  /** Reload contributed themes (plugins may come and go at runtime). */
  refreshPluginThemes: () => Promise<void>;
  /** Reload contributed work panel views (scope and lifecycle change them). */
  refreshPluginViews: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  receiveNotification: (notification: AppNotification) => void;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  clearNotifications: () => Promise<void>;
  openNotification: (id: string) => Promise<void>;
  /** Drop a session's sidebar outcome badge and read its task notifications. */
  acknowledgeSessionOutcome: (sessionId: string) => Promise<void>;
  restorePendingPlan: (sessionId: string) => Promise<PendingPlanRefreshResult>;
  refreshPlanCheckpoints: () => Promise<void>;
  handleAgentEvent: (envelope: AgentEventEnvelope) => void;
  handlePlansChanged: (event: PlanningStateEvent) => void;
  setPage: (page: AppState["page"], opts?: { record?: boolean }) => void;
  setSettingsTab: (tab: AppState["settingsTab"]) => void;
  setSettingsAnchor: (key: string | null) => void;
  navBack: () => void;
  navForward: () => void;
  canNavBack: () => boolean;
  canNavForward: () => boolean;
  resolvePermission: (
    sessionId: string,
    requestId: string,
    decision: "allow-once" | "allow-session" | "deny",
  ) => Promise<void>;
  resolveAsk: (
    sessionId: string,
    resolution: AskToolResolution,
  ) => Promise<void>;
  resolvePlan: (resolution: PlanResolveRequest) => Promise<PlanResolutionResult>;
  showToast: (message: string, options?: ToastOptions) => void;
  dismissToast: (id: number) => void;
  composerPrefill: ComposerPrefill | null;
  clearComposerPrefill: () => void;
  workPanelOpen: boolean;
  workPanelTabs: WorkPanelTab[];
  activeWorkPanelTabId: string | null;
  /** Runtime-only work panel state owned by each conversation. */
  workPanelContexts: Record<string, WorkPanelContext>;
  workPanelWidth: number;
  /** Chat-initiated "preview this file" request consumed by the files tab. */
  workPanelFileRequest: { path: string; seq: number } | null;
  /** Reveal the active session's retained work panel without creating a tab. */
  openWorkPanel: () => void;
  /** Flip the work panel between revealed and collapsed for the active session. */
  toggleWorkPanel: () => void;
  openWorkPanelTab: (tab: WorkPanelTab) => void;
  openWorkPanelTabForSession: (sessionId: string, tab: WorkPanelTab) => void;
  activateWorkPanelTab: (tabId: string) => void;
  closeWorkPanelTab: (tabId: string) => void;
  collapseWorkPanel: () => void;
  /** Hide the visible panel while retaining its session-owned context. */
  resetWorkPanelContext: () => void;
  setWorkPanelWidth: (width: number) => void;
  /** Open a workspace-relative file in the work panel files viewer. */
  openFileInWorkPanel: (path: string) => void;
  /** Open a URL in the work panel browser tab. */
  openUrlInWorkPanel: (url: string) => void;
};

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

const initialSidebarPreferences = loadSidebarPreferences();
const initialWorkPanelWidth = loadWorkPanelWidth();

function currentWorkPanelContext(state: AppState): WorkPanelContext {
  const tabs = sanitizeWorkPanelTabsState({
    tabs: state.workPanelTabs,
    activeTabId: state.activeWorkPanelTabId,
  });
  return {
    open: state.workPanelOpen,
    tabs: tabs.tabs,
    activeTabId: tabs.activeTabId,
    fileRequest: state.workPanelFileRequest,
  };
}

function switchWorkPanelSession(
  state: AppState,
  nextSessionId?: string,
): Pick<
  AppState,
  | "workPanelContexts"
  | "workPanelOpen"
  | "workPanelTabs"
  | "activeWorkPanelTabId"
  | "workPanelFileRequest"
> {
  const switched = switchWorkPanelContextState(
    state.workPanelContexts,
    state.activeSessionId,
    currentWorkPanelContext(state),
    nextSessionId,
  );
  return {
    workPanelContexts: switched.contexts,
    workPanelOpen: switched.visible.open,
    workPanelTabs: switched.visible.tabs,
    activeWorkPanelTabId: switched.visible.activeTabId,
    workPanelFileRequest: switched.visible.fileRequest,
  };
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

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  healthOk: false,
  sessions: [],
  sessionMeta: initialSidebarPreferences.sessionMeta,
  sessionView: {
    ...initialSidebarPreferences.sessionView,
    sortBy: initialSidebarPreferences.sessionView.sort,
    showArchived: initialSidebarPreferences.sessionView.archived,
  },
  openProjects: initialSidebarPreferences.openProjectPaths.map(projectWorkspaceFromPath),
  openProjectPaths: initialSidebarPreferences.openProjectPaths,
  activeProjectPath: undefined,
  projectMeta: initialSidebarPreferences.projectMeta,
  projectCollapsed: Object.fromEntries(
    Object.entries(initialSidebarPreferences.projectMeta)
      .filter(([, meta]) => meta.collapsed === true)
      .map(([path]) => [path, true]),
  ),
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

  bootstrap: async () => {
    try {
      const [
        version,
        health,
        settingsRaw,
        sessions,
        providers,
        project,
        onboarding,
        plugins,
        notifications,
        pendingPlansResult,
      ] =
        await Promise.all([
          api.getVersion(),
          api.health(),
          api.getSettings(),
          api.listSessions(),
          api.listProviders(),
          api.getProject(),
          api.getOnboarding(),
          api.listPlugins(),
          api.listNotifications({ limit: 200 }),
          api.pendingPlans(),
        ]);
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
      const currentWorkspace = project.workspace;
      const persistedPaths = get().openProjectPaths;
      // Only explicitly retained tabs are restored. Historical sessions stay
      // available in Projects, but must not silently reopen a tab that was
      // intentionally closed.
      const openProjectPaths = currentWorkspace?.path
        ? promoteProjectPath(persistedPaths, currentWorkspace.path)
        : persistedPaths;
      const openProjects = openProjectPaths.map((path) => projectWorkspaceFromPath(path));
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
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  refreshSessions: async () => {
    const sessions = await api.listSessions();
    set({ sessions: decorateSessions(sessions.sessions, get().sessionMeta) });
  },

  restorePendingPlan: async (sessionId) => {
    if (!sessionId) return "unavailable";
    const generation = nextPlanSyncGeneration(sessionId);
    try {
      const result = await api.pendingPlans(sessionId);
      if (generation !== planSyncGeneration(sessionId)) return "unavailable";
      const existingCheckpoint = get().planCheckpoints[sessionId];
      const wasPending = existingCheckpoint?.status === "pending";
      const proposal = latestPlanProposal(result.plans, sessionId);
      const durableMode = get().sessions.find(
        (session) => session.id === sessionId,
      )?.mode;
      const nextState =
        result.state ??
        (proposal?.status === "pending"
          ? "awaiting_approval"
          : durableMode === "plan" || durableMode === "goal"
            ? "planning"
            : "inactive");
      // The host's live kind wins; a pending proposal or the durable mode is
      // the fallback when the response predates the discriminator.
      const nextKind: ProposalKind | undefined =
        result.kind ??
        proposal?.kind ??
        (durableMode === "plan" || durableMode === "goal"
          ? durableMode
          : undefined);
      const checkpoint =
        proposal ??
        (existingCheckpoint?.status === "pending" &&
        nextState === "awaiting_approval"
          ? existingCheckpoint
          : terminalizeMissingPlan(existingCheckpoint, nextState));
      const activeProposal =
        nextState === "awaiting_approval" && isPendingPlan(checkpoint)
          ? checkpoint
          : undefined;
      const executionActive = isActivePlanExecution(checkpoint);
      const planRunSettled = Boolean(activeProposal || executionActive || wasPending);
      set((state) => ({
        planningStates: {
          ...state.planningStates,
          [sessionId]: nextState,
        },
        planCheckpoints: checkpoint
          ? { ...state.planCheckpoints, [sessionId]: checkpoint }
          : state.planCheckpoints,
        pendingPlans: activeProposal
          ? { ...state.pendingPlans, [sessionId]: activeProposal }
          : withoutRecordKey(state.pendingPlans, sessionId),
        runningSessions: planRunSettled
          ? { ...state.runningSessions, [sessionId]: executionActive }
          : state.runningSessions,
        isRunning:
          state.activeSessionId === sessionId && planRunSettled
            ? executionActive
            : state.isRunning,
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                mode: sessionModeForPlanningState(nextState, nextKind),
              }
            : session,
        ),
      }));
      if (checkpoint && activeProposal) {
        openPlanArtifact(checkpoint, get().openWorkPanelTabForSession);
      }
      return activeProposal ? "pending" : "terminal";
    } catch {
      // A transient host failure must not erase a live approval already held
      // by the renderer; the next host event or activation retries it.
      return "unavailable";
    }
  },

  refreshPlanCheckpoints: async () => {
    const sessionIds = get().sessions.map((session) => session.id);
    await Promise.allSettled(
      sessionIds.map((sessionId) => get().restorePendingPlan(sessionId)),
    );
  },

  prefetchSession: async (id) => {
    if (!id || sessionTranscriptCache.has(id)) return;
    await loadSessionDetail(id, {
      messageLimit: SESSION_TRANSCRIPT_PAGE_SIZE,
      contentLimit: SESSION_TRANSCRIPT_CONTENT_LIMIT,
    });
  },

  loadOlderMessages: async (sessionId) => {
    const window = get().sessionHistory[sessionId];
    if (!window?.hasMoreBefore || sessionOlderLoads.has(sessionId)) return;
    const before = window.messageStart;
    const request = api
      .getSession(sessionId, {
        messageBefore: before,
        messageLimit: SESSION_TRANSCRIPT_PAGE_SIZE,
        contentLimit: SESSION_TRANSCRIPT_CONTENT_LIMIT,
      })
      .then((detail) => {
        const page = detail.session;
        if (!page) return;
        const nextWindow = {
          messageStart: page.messageStart ?? Math.max(0, before - page.messages.length),
          hasMoreBefore: page.hasMoreBefore === true,
        };
        const cached = sessionTranscriptCache.get(sessionId) ?? [];
        const cachedStart = sessionHistoryCache.get(sessionId)?.messageStart ?? before;
        // A newer navigation or another prepend wins; never duplicate a page
        // after a stale response arrives.
        if (cachedStart !== before && cached.length > 0) return;
        const merged = mergeLiveSessionMessages(page.messages, cached);
        cacheSessionTranscript(sessionId, merged, nextWindow);
        set((state) =>
          state.activeSessionId === sessionId
            ? {
                messages: mergeLiveSessionMessages(page.messages, state.messages),
                sessionHistory: {
                  ...state.sessionHistory,
                  [sessionId]: nextWindow,
                },
              }
            : {
                sessionHistory: {
                  ...state.sessionHistory,
                  [sessionId]: nextWindow,
                },
              },
        );
      })
      .finally(() => {
        if (sessionOlderLoads.get(sessionId) === request) {
          sessionOlderLoads.delete(sessionId);
        }
      });
    sessionOlderLoads.set(sessionId, request);
    await request;
  },

  selectSession: async (id, opts) => {
    const intent = opts?.navigationIntent ?? beginNavigationIntent();
    const selection = { id, intent };
    pendingSessionSelection = selection;
    const stateAtStart = get();
    const runningAtSelection = stateAtStart.runningSessions[id] === true;
    if (runningAtSelection) liveSessionTranscripts.add(id);
    if (stateAtStart.activeSessionId) {
      cacheSessionTranscript(
        stateAtStart.activeSessionId,
        stateAtStart.messages,
        stateAtStart.sessionHistory[stateAtStart.activeSessionId],
      );
    }
    set({ selectingSessionId: id, page: "chat" });

    const commitSelection = (
      messages: UiMessage[],
      revalidating: boolean,
      historyWindow: SessionHistoryWindow =
        sessionHistoryCache.get(id) ?? { messageStart: 0, hasMoreBefore: false },
    ) => {
      const record = opts?.record !== false;
      if (!record) {
        set((s) => ({
          ...(s.activeSessionId === id ? {} : switchWorkPanelSession(s, id)),
          ...retainSessionPane(s, id, messages),
          activeSessionId: id,
          selectingSessionId: revalidating ? id : undefined,
          messages,
          sessionHistory: { ...s.sessionHistory, [id]: historyWindow },
          page: "chat",
          isRunning: s.runningSessions[id] ?? false,
        }));
        return;
      }
      const entry = { page: "chat" as const, sessionId: id };
      set((s) => {
        const stack = s.navStack.slice(0, s.navIndex + 1);
        const last = stack[stack.length - 1];
        const same = last?.page === "chat" && last?.sessionId === id;
        const nextStack = same ? stack : [...stack, entry].slice(-50);
        return {
          ...(s.activeSessionId === id ? {} : switchWorkPanelSession(s, id)),
          ...retainSessionPane(s, id, messages),
          activeSessionId: id,
          selectingSessionId: revalidating ? id : undefined,
          messages,
          sessionHistory: { ...s.sessionHistory, [id]: historyWindow },
          page: "chat" as const,
          isRunning: s.runningSessions[id] ?? false,
          navStack: nextStack,
          navIndex: nextStack.length - 1,
        };
      });
    };

    const alignWorkspace = async (projectPath?: string | null) => {
      if (projectPath) {
        if (
          !sessionMatchesProject(
            { projectPath: get().activeProjectPath },
            projectPath,
          )
        ) {
          const workspace = await get().activateProject(projectPath, {
            navigationIntent: intent,
          });
          if (!navigationIntentIsCurrent(intent)) return false;
          if (!workspace) throw new Error("Unable to activate project workspace");
        }
      } else if (get().workspace) {
        await get().clearProject({ navigationIntent: intent });
        if (!navigationIntentIsCurrent(intent)) return false;
      }
      return navigationIntentIsCurrent(intent);
    };

    const alignWorkspaceLatest = (projectPath?: string | null) => {
      const task = sessionWorkspaceQueue.then(
        () => alignWorkspace(projectPath),
        () => alignWorkspace(projectPath),
      );
      sessionWorkspaceQueue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };

    try {
      if (!navigationIntentIsCurrent(intent)) return;
      const summary = get().sessions.find((session) => session.id === id);
      // Start transcript IO immediately. When summary metadata is available,
      // workspace alignment runs beside it instead of adding another round trip.
      const detailPromise = loadSessionDetail(id, {
        messageLimit: SESSION_TRANSCRIPT_PAGE_SIZE,
        contentLimit: SESSION_TRANSCRIPT_CONTENT_LIMIT,
      });
      let detail: Awaited<typeof detailPromise> | undefined;
      // A retained pane already holds this session's painted transcript
      // (ADR 0137). Reveal it before awaiting workspace alignment so a warm
      // switch shows the destination on its first frame; the revalidated
      // transcript lands in the same pane afterwards.
      const retainedMessages =
        sessionTranscriptCache.get(id) ?? get().retainedTranscripts[id];
      if (retainedMessages && get().activeSessionId !== id && summary) {
        commitSelection(retainedMessages, true);
      } else if (
        summary &&
        get().activeSessionId !== id &&
        sessionIsReusableEmpty(summary, {
          running: runningAtSelection,
          liveMessageCount: retainedMessages?.length ?? 0,
          submitted: submittedComposerDrafts.has(id),
        })
      ) {
        // An empty destination has nothing to load. Reveal it on this frame
        // instead of leaving the previous transcript up during session.get.
        cacheSessionTranscript(id, [], EMPTY_SESSION_WINDOW);
        commitSelection([], true, EMPTY_SESSION_WINDOW);
      }
      if (summary) {
        if (!(await alignWorkspaceLatest(summary.projectPath))) return;
      } else {
        detail = await detailPromise;
        if (!navigationIntentIsCurrent(intent)) return;
        if (!(await alignWorkspaceLatest(detail.session?.projectPath))) return;
      }

      const cachedMessages = sessionTranscriptCache.get(id);
      if (cachedMessages && navigationIntentIsCurrent(intent)) {
        cacheSessionTranscript(id, cachedMessages, sessionHistoryCache.get(id));
        commitSelection(cachedMessages, true, sessionHistoryCache.get(id));
      }

      detail ??= await detailPromise;
      if (!navigationIntentIsCurrent(intent)) return;
      const historyWindow = detail.session
        ? {
            messageStart: detail.session.messageStart ?? 0,
            hasMoreBefore: detail.session.hasMoreBefore === true,
          }
        : { messageStart: 0, hasMoreBefore: false };
      const currentState = get();
      const liveMessages =
        (runningAtSelection || currentState.runningSessions[id] === true)
          ? currentState.activeSessionId === id
            ? currentState.messages
            : sessionTranscriptCache.get(id) ??
              currentState.retainedTranscripts[id]
          : undefined;
      const selectedMessages = detail.session
        ? liveMessages
          ? mergeLiveSessionMessages(detail.session.messages ?? [], liveMessages)
          : detail.session.messages ?? []
        : liveMessages ?? [];
      if (detail.session) {
        cacheSessionTranscript(id, selectedMessages, historyWindow);
      }
      commitSelection(selectedMessages, false, historyWindow);
      if (currentState.runningSessions[id] !== true) {
        liveSessionTranscripts.delete(id);
      }
      rememberSessionCompactions(id, detail.session);
      void get().restorePendingPlan(id);
      void get().acknowledgeSessionOutcome(id);
    } finally {
      if (pendingSessionSelection === selection) {
        pendingSessionSelection = null;
        set((state) =>
          state.selectingSessionId === id
            ? { selectingSessionId: undefined }
            : {},
        );
      }
    }
  },

  newSession: async (options) => {
    const requestedProjectPath =
      options && "projectPath" in options
        ? options.projectPath ?? null
        : get().workspace?.path ?? null;
    const scopeKey = newSessionScopeKey(requestedProjectPath);
    const pending = pendingNewSessionRequests.get(scopeKey);
    if (pending) {
      await pending;
      return;
    }

    const intent = beginNavigationIntent();
    const request = (async () => {
      if (
        requestedProjectPath &&
        !sessionMatchesProject(
          { projectPath: get().activeProjectPath },
          requestedProjectPath,
        )
      ) {
        const workspace = await get().activateProject(requestedProjectPath, {
          navigationIntent: intent,
        });
        if (!navigationIntentIsCurrent(intent)) return;
        if (!workspace) throw new Error("Unable to activate project workspace");
      }
      if (requestedProjectPath === null && get().workspace) {
        await get().clearProject({ navigationIntent: intent });
        if (!navigationIntentIsCurrent(intent)) return;
      }

      // Reuse against renderer state: a just-sent first message is already
      // visible as a running session, live rows, or a submitted draft, even
      // when session.list has not yet refreshed messageCount.
      const latest = latestSessionInScope(
        get().sessions,
        requestedProjectPath,
        get().sessionMeta,
      );
      if (
        latest &&
        sessionIsReusableEmpty(latest, {
          running: get().runningSessions[latest.id] === true,
          liveMessageCount: liveMessageCountForSession(latest.id, get()),
          submitted: submittedComposerDrafts.has(latest.id),
        })
      ) {
        if (get().activeSessionId === latest.id && get().page === "chat") return;
        await get().selectSession(latest.id, { navigationIntent: intent });
        return;
      }

      await persistSessionAndSelect({
        intent,
        projectPath: requestedProjectPath,
        draftConfiguration: null,
      });
    })();
    pendingNewSessionRequests.set(scopeKey, request);
    try {
      await request;
    } finally {
      if (pendingNewSessionRequests.get(scopeKey) === request) {
        pendingNewSessionRequests.delete(scopeKey);
      }
    }
  },

  forkSession: async (id) => {
    const intent = beginNavigationIntent();
    const state = get();
    if (!id || state.runningSessions[id]) return;
    const source = state.sessions.find((session) => session.id === id);
    if (!source) throw new Error("Session not found");

    if (source.projectPath) {
      if (
        !sessionMatchesProject(
          { projectPath: state.activeProjectPath },
          source.projectPath,
        )
      ) {
        const workspace = await get().activateProject(source.projectPath, {
          navigationIntent: intent,
        });
        if (!navigationIntentIsCurrent(intent)) return;
        if (!workspace) throw new Error("Unable to activate project workspace");
      }
    } else if (state.workspace) {
      await get().clearProject({ navigationIntent: intent });
      if (!navigationIntentIsCurrent(intent)) return;
    }

    const sourceTitle = source.title.trim() || i18n.t("chat.untitledTask");
    const result = await api.forkSession(
      id,
      i18n.t("nav.branchTitle", { title: sourceTitle }),
    );
    // The child is already durable on the host. Recording it is unconditional;
    // only activating it depends on this navigation still owning the view.
    commitForkedSession(result.session, {
      activate: navigationIntentIsCurrent(intent),
    });
  },

  forkAssistantMessage: async (messageId) => {
    const intent = beginNavigationIntent();
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId || state.runningSessions[sessionId]) return;
    const message = state.messages.find((candidate) => candidate.id === messageId);
    const source = state.sessions.find((session) => session.id === sessionId);
    if (!message || message.role !== "assistant" || !source) return;

    try {
      const sourceTitle = source.title.trim() || i18n.t("chat.untitledTask");
      const result = await api.forkSession(
        sessionId,
        i18n.t("nav.branchTitle", { title: sourceTitle }),
        messageId,
      );
      commitForkedSession(result.session, {
        activate: navigationIntentIsCurrent(intent),
        clearError: true,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string })?.code ?? null,
      });
    }
  },

  configureActiveSession: async (config) => {
    const sessionId = get().activeSessionId;
    // The home composer can be visible while project/session navigation has
    // cleared the active id. Keep the toolbar choice on the unpersisted
    // draft and apply it when the first message creates the session instead
    // of materializing a history row for a toolbar-only interaction.
    if (!sessionId) {
      set((state) => ({
        draftConfiguration: {
          mode: config.mode,
          thinkingLevel: config.thinkingLevel,
          providerId:
            config.providerId ?? state.draftConfiguration?.providerId,
          modelId: config.modelId ?? state.draftConfiguration?.modelId,
          permissionMode:
            config.permissionMode ?? state.draftConfiguration?.permissionMode,
        },
      }));
      return;
    }
    if (get().pendingPlans[sessionId]?.status === "pending") return;
    if (
      get().runningSessions[sessionId] ||
      sessionConfigurationFlushes.has(sessionId)
    ) {
      pendingSessionConfigurations.set(sessionId, config);
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? applyOptimisticSessionConfiguration(session, config)
            : session,
        ),
      }));
      return;
    }
    const result = await api.configureSession(sessionId, config);
    set((state) => ({
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
        [sessionId]: result.session.mode === "plan" ? "planning" : "inactive",
      },
    }));
  },

  enqueuePrompt: (content, draft, requestedSessionId) => {
    const sessionId = requestedSessionId ?? get().activeSessionId;
    if (!sessionId) return;
    const queuedDraft: ComposerDraftSnapshot = draft
      ? {
          text: draft.text,
          fileReferences: draft.fileReferences.map((reference) => ({
            ...reference,
          })),
        }
      : { text: content, fileReferences: [] };
    const item: QueuedPrompt = {
      id: crypto.randomUUID(),
      sessionId,
      content,
      draft: queuedDraft,
      createdAt: Date.now(),
    };
    set((state) => ({
      queuedPrompts: enqueueQueuedPrompt(state.queuedPrompts, item),
    }));
  },

  removeQueuedPrompt: (promptId) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((state) => ({
      queuedPrompts: removeQueuedPrompt(
        state.queuedPrompts,
        sessionId,
        promptId,
      ),
    }));
  },

  sendQueuedNow: async (promptId) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const item = queuedPromptForSession(
      get().queuedPrompts,
      sessionId,
      promptId,
    );
    if (!item) return;
    if (get().runningSessions[sessionId]) {
      if (item.sendNowRequested) return;
      set((state) => ({
        queuedPrompts: prioritizeQueuedPrompt(
          state.queuedPrompts,
          sessionId,
          promptId,
        ),
      }));
      try {
        const result = await api.stop(sessionId);
        if (!result.requested) {
          set((state) => ({
            queuedPrompts: clearQueuedPromptSendNow(
              state.queuedPrompts,
              sessionId,
            ),
          }));
          if (!get().runningSessions[sessionId]) {
            void drainQueuedPrompts(sessionId);
          }
        }
      } catch (error) {
        set((state) => ({
          queuedPrompts: clearQueuedPromptSendNow(
            state.queuedPrompts,
            sessionId,
          ),
        }));
        get().showToast(
          error instanceof Error ? error.message : String(error),
          { variant: "error" },
        );
      }
      return;
    }

    set((state) => ({
      queuedPrompts: removeQueuedPrompt(
        state.queuedPrompts,
        sessionId,
        promptId,
      ),
    }));
    const accepted = await get().sendPrompt(item.content, item.draft, sessionId);
    if (!accepted) {
      set((state) => ({
        queuedPrompts: enqueueQueuedPrompt(state.queuedPrompts, {
          ...item,
          sendNowRequested: undefined,
        }),
      }));
    }
  },

  sendPrompt: async (content, draft, requestedSessionId) => {
    let sessionId = requestedSessionId ?? get().activeSessionId;
    if (sessionId && get().pendingPlans[sessionId]?.status === "pending") {
      return false;
    }
    if (!sessionId) {
      // The new-task draft is unpersisted until its first message: sending
      // now creates the session and its sidebar history row.
      const intent = beginNavigationIntent();
      const createdId = await materializeDraftSession(intent);
      if (!createdId) return false;
      sessionId = createdId;
    }
    if (!sessionId) throw new Error("No active session");
    if (get().pendingPlans[sessionId]?.status === "pending") return false;
    if (get().runningSessions[sessionId]) {
      get().enqueuePrompt(content, draft, sessionId);
      return true;
    }
    const startedIn = sessionId;
    const messageCountBeforeSend =
      startedIn === get().activeSessionId
        ? get().messages.length
        : sessionTranscriptCache.get(startedIn)?.length ?? 0;
    const submission: SubmittedComposerDraft = {
      messageCountBeforeSend,
      draft: draft
        ? {
            text: draft.text,
            fileReferences: draft.fileReferences.map((reference) => ({
              ...reference,
            })),
          }
        : { text: content, fileReferences: [] },
    };
    submittedComposerDrafts.set(startedIn, submission);
    set((s) => ({
      isRunning: s.activeSessionId === startedIn ? true : s.isRunning,
      error: null,
      errorCode: null,
      errorRetriable: null,
      runningSessions: { ...s.runningSessions, [startedIn]: true },
      latestTurnResults: withoutRecordKey(s.latestTurnResults, startedIn),
      sessionOutcomes: withoutRecordKey(s.sessionOutcomes, startedIn),
    }));
    // The prompt is on screen before the host round trip (D288). The host
    // persists and echoes the row under this same id, so the echo replaces
    // the optimistic row instead of adding a second one.
    const optimisticMessage = optimisticUserMessage(
      crypto.randomUUID(),
      content,
      submission.draft.fileReferences,
    );
    insertOptimisticUserMessage(startedIn, optimisticMessage);
    try {
      const current = get().sessions.find((s) => s.id === sessionId);
      if (isDefaultSessionTitle(current?.title)) {
        const nextTitle =
          content.trim().replace(/\s+/g, " ").slice(0, 48) || untitledTaskTitle();
        // Fire-and-forget: renaming the sidebar title must not delay the prompt
        // reaching the agent runtime — removes visible lag after pressing Enter.
        api.renameSession(sessionId, nextTitle)
          .then(() => get().refreshSessions())
          .catch(() => { /* non-fatal */ });
      }
      if (get().pendingPlans[sessionId]?.status === "pending") {
        submittedComposerDrafts.delete(startedIn);
        retractOptimisticUserMessage(startedIn, optimisticMessage);
        set((s) => ({
          isRunning: s.activeSessionId === startedIn ? false : s.isRunning,
          runningSessions: { ...s.runningSessions, [startedIn]: false },
        }));
        return false;
      }
      if (submission.abortResolution && (await submission.abortResolution)) {
        // Smart stop already pulled the row back into the composer.
        submittedComposerDrafts.delete(startedIn);
        return false;
      }
      await api.prompt({
        sessionId,
        content,
        messageId: optimisticMessage.id,
        viewingSessionId: viewingSessionIdForPrompt(get(), sessionId),
        attachments: draft
          ? promptAttachmentsFromDraft(draft.fileReferences)
          : [],
      });
      if (submission.abortResolution && (await submission.abortResolution)) {
        return false;
      }
      return true;
    } catch (e) {
      submittedComposerDrafts.delete(startedIn);
      retractOptimisticUserMessage(startedIn, optimisticMessage);
      const messageError = messageErrorFromUnknown(e);
      set((s) => ({
        // The user may have switched sessions while the request was in
        // flight; only reset the spinner if the failed session is visible.
        isRunning: s.activeSessionId === startedIn ? false : s.isRunning,
        runningSessions: { ...s.runningSessions, [startedIn]: false },
        latestTurnResults: {
          ...s.latestTurnResults,
          [startedIn]: {
            status: "failed",
            turnId: `${startedIn}:${Date.now()}`,
            finishedAt: Date.now(),
            errorCode: messageError.code,
          },
        },
        sessionOutcomes: { ...s.sessionOutcomes, [startedIn]: "failed" },
        ...(s.activeSessionId === startedIn
          ? { messages: [...s.messages, assistantErrorMessage(messageError)] }
          : {}),
      }));
      return false;
    }
  },

  compactContext: async () => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId || state.isRunning) return;
    set((current) => ({
      isRunning: true,
      runningSessions: {
        ...current.runningSessions,
        [sessionId]: true,
      },
    }));
    try {
      await api.compact({ sessionId });
    } catch (error) {
      set((current) => ({
        isRunning:
          current.activeSessionId === sessionId ? false : current.isRunning,
        runningSessions: {
          ...current.runningSessions,
          [sessionId]: false,
        },
      }));
      // A started compaction reports its own failure through compaction_end.
      // Keep this fallback for launch/configuration failures that occur before
      // the runtime can emit lifecycle events.
      if ((error as { code?: string })?.code !== "CONTEXT_COMPACTION_FAILED") {
        get().showToast(
          error instanceof Error
            ? error.message
            : i18n.t("contextCompaction.failed"),
          { variant: "error" },
        );
      }
    }
  },

  retryAssistantMessage: async (messageId) => {
    const state = get();
    if (state.isRunning) return;
    const index = state.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const target = state.messages[index];
    if (target.role !== "assistant") return;

    // Branch from the nearest preceding user prompt, resending it verbatim.
    // Slash prompts resend their expanded body so the model sees exactly what
    // it saw before (D123).
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = state.messages[i];
      if (
        candidate.role === "user" &&
        (candidate.content.trim() || candidate.attachments?.length)
      ) {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    const root = state.messages[userIndex];
    await get().editUserMessage(root.id, root.content, root.attachments);
  },

  editUserMessage: async (messageId, content, attachments) => {
    // Editing a prompt is a regenerate with different text: keep history up to
    // that prompt (exclusive), then send the new text so the durable
    // transcript and live agent both drop the discarded assistant/tool tail.
    // Main archives the replaced branch as a revision, so the pager can walk
    // back to the original prompt and its answer.
    const state = get();
    if (state.isRunning) return false;
    const sessionId = state.activeSessionId;
    if (!sessionId) return false;
    if (state.pendingPlans[sessionId]?.status === "pending") return false;
    const prompt = content.trim();
    const userIndex = state.messages.findIndex(
      (message) => message.id === messageId,
    );
    if (userIndex < 0 || state.messages[userIndex].role !== "user") return false;
    if (
      !prompt &&
      !(attachments ?? state.messages[userIndex].attachments)?.length
    ) {
      return false;
    }
    const promptAttachments = promptAttachmentsFromMessage(
      attachments ?? state.messages[userIndex].attachments,
    );
    const kept = state.messages.slice(0, userIndex);
    // Name the boundary rather than computing it: a window offset plus an
    // index into the deduplicated renderer array are different coordinate
    // spaces, and mixing them cuts the wrong message on a paged transcript.
    const truncateFromMessageId = state.messages[userIndex].id;
    // The rewritten prompt shows in place of the old row before the host
    // round trip (D288); the durable echo replaces it under the same id.
    const optimisticMessage = optimisticUserMessage(
      crypto.randomUUID(),
      prompt,
      (attachments ?? state.messages[userIndex].attachments ?? []).map(
        (attachment) => ({
          path: attachment.ref,
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
        }),
      ),
    );

    set((s) => ({
      messages: [...kept, optimisticMessage],
      isRunning: true,
      error: null,
      errorCode: null,
      errorRetriable: null,
      runningSessions: { ...s.runningSessions, [sessionId]: true },
      latestTurnResults: withoutRecordKey(s.latestTurnResults, sessionId),
      sessionOutcomes: withoutRecordKey(s.sessionOutcomes, sessionId),
    }));

    try {
      await api.prompt({
        sessionId,
        content: prompt,
        messageId: optimisticMessage.id,
        viewingSessionId: viewingSessionIdForPrompt(get(), sessionId),
        attachments: promptAttachments,
        truncateFromMessageId,
      });
      return true;
    } catch (e) {
      // Reload durable state if the branch failed mid-flight.
      try {
        const detail = await api.getSession(sessionId);
        set((s) => ({
          messages:
            s.activeSessionId === sessionId
              ? detail.session?.messages ?? kept
              : s.messages,
          isRunning: s.activeSessionId === sessionId ? false : s.isRunning,
          runningSessions: { ...s.runningSessions, [sessionId]: false },
          latestTurnResults: {
            ...s.latestTurnResults,
            [sessionId]: {
              status: "failed",
              turnId: `${sessionId}:${Date.now()}`,
              finishedAt: Date.now(),
              errorCode: (e as { code?: string })?.code,
            },
          },
          sessionOutcomes: { ...s.sessionOutcomes, [sessionId]: "failed" },
          error: e instanceof Error ? e.message : String(e),
          errorCode: (e as { code?: string })?.code ?? null,
        }));
      } catch {
        set((s) => ({
          isRunning: s.activeSessionId === sessionId ? false : s.isRunning,
          runningSessions: { ...s.runningSessions, [sessionId]: false },
          latestTurnResults: {
            ...s.latestTurnResults,
            [sessionId]: {
              status: "failed",
              turnId: `${sessionId}:${Date.now()}`,
              finishedAt: Date.now(),
              errorCode: (e as { code?: string })?.code,
            },
          },
          sessionOutcomes: { ...s.sessionOutcomes, [sessionId]: "failed" },
          error: e instanceof Error ? e.message : String(e),
          errorCode: (e as { code?: string })?.code ?? null,
        }));
      }
      return false;
    }
  },

  retryLastPrompt: async () => {
    // Re-send the newest user prompt after a failed turn (error banner
    // "Retry"). Same branch semantics as retryAssistantMessage, anchored on
    // the last user message so it also works when the turn died before any
    // assistant output.
    const state = get();
    if (state.isRunning) return;
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    if (state.pendingPlans[sessionId]?.status === "pending") return;
    let userIndex = -1;
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const candidate = state.messages[i];
      if (
        candidate.role === "user" &&
        (candidate.content.trim() || candidate.attachments?.length)
      ) {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    const prompt = state.messages[userIndex].content;
    const promptAttachments = promptAttachmentsFromMessage(
      state.messages[userIndex].attachments,
    );
    const kept = state.messages.slice(0, userIndex);
    // Name the boundary rather than computing it: a window offset plus an
    // index into the deduplicated renderer array are different coordinate
    // spaces, and mixing them cuts the wrong message on a paged transcript.
    const truncateFromMessageId = state.messages[userIndex].id;
    set((s) => ({
      messages: kept,
      isRunning: true,
      error: null,
      errorCode: null,
      errorRetriable: null,
      runningSessions: { ...s.runningSessions, [sessionId]: true },
      latestTurnResults: withoutRecordKey(s.latestTurnResults, sessionId),
      sessionOutcomes: withoutRecordKey(s.sessionOutcomes, sessionId),
    }));
    try {
      await api.prompt({
        sessionId,
        content: prompt,
        viewingSessionId: viewingSessionIdForPrompt(get(), sessionId),
        attachments: promptAttachments,
        truncateFromMessageId,
      });
    } catch (e) {
      set((s) => ({
        isRunning: s.activeSessionId === sessionId ? false : s.isRunning,
        runningSessions: { ...s.runningSessions, [sessionId]: false },
        latestTurnResults: {
          ...s.latestTurnResults,
          [sessionId]: {
            status: "failed",
            turnId: `${sessionId}:${Date.now()}`,
            finishedAt: Date.now(),
            errorCode: (e as { code?: string })?.code,
          },
        },
        sessionOutcomes: { ...s.sessionOutcomes, [sessionId]: "failed" },
        error: e instanceof Error ? e.message : String(e),
        errorCode: (e as { code?: string })?.code ?? null,
        errorRetriable: false,
      }));
    }
  },

  clearError: () => set({ error: null, errorCode: null, errorRetriable: null }),

  activateMessageRevision: async (rootUserId, revisionIndex) => {
    let state = get();
    if (state.isRunning) return;
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    if (state.sessionHistory[sessionId]?.hasMoreBefore) {
      const fullMessages = await loadFullSessionMessages(sessionId);
      if (!fullMessages || get().activeSessionId !== sessionId) return;
      set((current) =>
        current.activeSessionId === sessionId
          ? {
              messages: fullMessages,
              sessionHistory: {
                ...current.sessionHistory,
                [sessionId]: { messageStart: 0, hasMoreBefore: false },
              },
            }
          : {},
      );
      state = get();
    }
    const rootIndex = state.messages.findIndex((message) => message.id === rootUserId);
    if (rootIndex < 0) return;
    const root = state.messages[rootIndex];
    // Live regenerate prompts get new ids; the durable family key stays on
    // revisionRootId so all variants remain one linear set.
    const revisionFamilyId = root.revisionRootId || root.id;
    const prefix = state.messages.slice(0, rootIndex);
    try {
      const result = await api.activateSessionRevision({
        sessionId,
        rootUserId: revisionFamilyId,
        revisionIndex,
        prefix,
      });
      set((s) => ({
        messages:
          s.activeSessionId === sessionId ? result.messages ?? prefix : s.messages,
        sessionHistory:
          s.activeSessionId === sessionId
            ? {
                ...s.sessionHistory,
                [sessionId]: { messageStart: 0, hasMoreBefore: false },
              }
            : s.sessionHistory,
        error: null,
        errorCode: null,
      }));
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        errorCode: (e as { code?: string })?.code ?? null,
      });
    }
  },

  deleteMessage: async (messageId) => {
    const sessionId = get().activeSessionId;
    if (!sessionId || get().isRunning) return;
    // The rewrite below replaces the whole transcript, so it must start from
    // the full durable copy: the renderer's window is paged and display-capped
    // (D299), and writing it back would truncate long rows on disk.
    const fullMessages = await loadFullSessionMessages(sessionId);
    if (!fullMessages || get().activeSessionId !== sessionId) return;
    set((current) =>
      current.activeSessionId === sessionId
        ? {
            messages: fullMessages,
            sessionHistory: {
              ...current.sessionHistory,
              [sessionId]: { messageStart: 0, hasMoreBefore: false },
            },
          }
        : {},
    );
    const state = get();
    const index = state.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const target = state.messages[index];
    // A prompt owns its exchange: deleting a user turn also drops the tool
    // and assistant tail up to the next user turn, so no orphaned replies
    // remain (retry resolves answers via the nearest preceding prompt).
    let end = index + 1;
    if (target.role === "user") {
      while (end < state.messages.length && state.messages[end].role !== "user") {
        end += 1;
      }
    }
    const previous = state.messages;
    const next = [...previous.slice(0, index), ...previous.slice(end)];
    const fullWindow = { messageStart: 0, hasMoreBefore: false };
    cacheSessionTranscript(sessionId, next, fullWindow);
    set((current) => ({
      messages: next,
      sessionHistory: { ...current.sessionHistory, [sessionId]: fullWindow },
      error: null,
      errorCode: null,
    }));
    try {
      await api.replaceSessionMessages(sessionId, next);
    } catch (e) {
      cacheSessionTranscript(sessionId, previous, fullWindow);
      set((s) => ({
        messages: s.activeSessionId === sessionId ? previous : s.messages,
        error: e instanceof Error ? e.message : String(e),
        errorCode: (e as { code?: string })?.code ?? null,
      }));
    }
  },

  rollbackWorkspaceChange: async (messageId, snapshotId) => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId || state.isRunning) return null;
    try {
      const result = await api.workspaceReviewRollback({
        sessionId,
        snapshotId,
      });
      if (result.status === "rolledBack" || result.status === "alreadyRolledBack") {
        set((current) =>
          current.activeSessionId === sessionId
            ? {
                messages: current.messages.map((message) =>
                  message.id === messageId
                    ? withReviewChangeState(message, "rolledBack")
                    : message,
                ),
              }
            : {},
        );
      } else if (result.status === "conflict") {
        get().showToast(i18n.t("panel.review.rollbackConflict"), {
          variant: "warning",
        });
      } else if (result.status === "unavailable") {
        get().showToast(i18n.t("panel.review.rollbackUnavailable"), {
          variant: "warning",
        });
      }
      return result;
    } catch (error) {
      get().showToast(i18n.t("panel.review.rollbackError"), {
        variant: "error",
      });
      set({
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string })?.code ?? null,
      });
      return null;
    }
  },

  abort: async () => {
    const stateBeforeAbort = get();
    const sessionId = stateBeforeAbort.activeSessionId;
    if (!sessionId) return;
    // Capture before awaiting the abort IPC: its terminal event may arrive
    // first and clear the pending snapshot.
    const submittedDraft = submittedComposerDrafts.get(sessionId);
    const stoppedAtMs = Date.now();
    if (submittedDraft && !submittedDraft.abortResolution) {
      submittedDraft.abortResolution = new Promise<boolean>((resolve) => {
        submittedDraft.resolveAbort = resolve;
      });
    }
    // Stopping the turn denies every request the session had open, not just
    // the one on screen: a queued delegate would otherwise keep its tool call
    // alive behind an abort the user already asked for.
    const pendingForSession = sessionPermissions(
      stateBeforeAbort.pendingPermissions,
      sessionId,
    );
    await Promise.allSettled([
      api.abort(sessionId),
      ...pendingForSession.map((permission) =>
        api.resolvePermission({
          requestId: permission.requestId,
          decision: "deny",
        }),
      ),
    ]);
    set((state) => ({
      pendingPermissions: clearSessionPermissions(
        state.pendingPermissions,
        sessionId,
      ),
    }));
    const state = get();
    if (state.activeSessionId !== sessionId) {
      submittedDraft?.resolveAbort?.(false);
      submittedComposerDrafts.delete(sessionId);
      set((s) => ({
        runningSessions: { ...s.runningSessions, [sessionId]: false },
      }));
      return;
    }
    const smartStop = resolveComposerSmartStop(state.messages, submittedDraft);
    if (smartStop.kind === "restore") {
      // Nothing came back yet — undo the send: pull the prompt into the
      // composer and drop the turn from the transcript. The rewrite must start
      // from the full durable transcript, never from the windowed, display-
      // capped copy the renderer holds (D299), and it must keep any reply row
      // the host persisted between the abort and this read.
      const fullMessages = await loadFullSessionMessages(sessionId);
      if (!fullMessages || get().activeSessionId !== sessionId) {
        submittedDraft?.resolveAbort?.(false);
        submittedComposerDrafts.delete(sessionId);
        return;
      }
      const merged = mergeLiveSessionMessages(fullMessages, get().messages);
      const fullStop = resolveComposerSmartStop(merged, submittedDraft);
      if (fullStop.kind === "restore") {
        submittedComposerDrafts.delete(sessionId);
        submittedDraft?.resolveAbort?.(true);
        const fullWindow = { messageStart: 0, hasMoreBefore: false };
        cacheSessionTranscript(sessionId, fullStop.kept, fullWindow);
        set((s) => ({
          messages: fullStop.kept,
          sessionHistory: { ...s.sessionHistory, [sessionId]: fullWindow },
          composerPrefill: { ...fullStop.draft, sessionId },
          isRunning: false,
          runningSessions: { ...s.runningSessions, [sessionId]: false },
        }));
        if (fullStop.kept.length < merged.length) {
          try {
            await api.replaceSessionMessages(sessionId, fullStop.kept);
          } catch {
            // Best effort — the local transcript already reflects the undo.
          }
        }
        void flushPendingSessionConfiguration(sessionId);
        return;
      }
      // The reply had started after all (its row landed while we looked).
      // Fall through and settle it in place on the full transcript.
      set((s) =>
        s.activeSessionId === sessionId
          ? {
              messages: merged,
              sessionHistory: {
                ...s.sessionHistory,
                [sessionId]: { messageStart: 0, hasMoreBefore: false },
              },
            }
          : {},
      );
    }
    submittedDraft?.resolveAbort?.(false);
    submittedComposerDrafts.delete(sessionId);
    // A partial reply exists: settle it in place. Streaming assistant text
    // becomes an aborted-but-kept answer; still-running tools close out. The
    // durable copy is the runtime's own aborted final row (or its last
    // checkpoint), so the renderer does not rewrite the transcript here: a
    // rewrite from this snapshot raced that row and could delete it (D299).
    const stoppedRows = (rows: UiMessage[]) =>
      rows.map((message) => {
        if (message.role === "assistant" && message.status === "streaming") {
          return {
            ...settleStoppedAssistantMetrics(message, stoppedAtMs),
            status: "aborted" as const,
          };
        }
        if (message.role === "tool" && message.toolStatus === "running") {
          return {
            ...message,
            toolStatus: "error" as const,
            status: "aborted" as const,
            toolCompletedAt: message.toolCompletedAt ?? new Date().toISOString(),
          };
        }
        return message;
      });
    set((s) => ({
      messages: s.activeSessionId === sessionId ? stoppedRows(s.messages) : s.messages,
      isRunning: false,
      runningSessions: { ...s.runningSessions, [sessionId]: false },
    }));
    void flushPendingSessionConfiguration(sessionId);
  },

  activateProject: async (path, opts) => {
    const intent = opts?.navigationIntent ?? beginNavigationIntent();
    const preserveConversation = pendingSessionSelection?.intent === intent;
    const requestedPath = path.trim();
    if (!requestedPath) return null;
    const result = await api.setProject(requestedPath);
    if (!navigationIntentIsCurrent(intent)) return null;
    const workspace = result.workspace;
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

  openProject: async () => {
    const intent = beginNavigationIntent();
    const result = await api.openProject();
    if (!navigationIntentIsCurrent(intent)) return;
    if (!result.canceled && result.workspace) {
      const workspace = result.workspace;
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
    const preserveConversation = pendingSessionSelection?.intent === intent;
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
    if (!nextTitle) throw new Error("Session title must not be empty");
    const result = await api.renameSession(id, nextTitle);
    if (!result.ok) throw new Error("Session not found");
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title: nextTitle } : session,
      ),
    }));
  },

  deleteSession: async (id) => {
    if (!id) return;
    await api.deleteSession(id);
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
      void drainQueuedPrompts(event.sessionId);
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
      void drainQueuedPrompts(envelope.sessionId);
    } else if (
      event.type === "agent_end" ||
      event.type === "error"
    ) {
      // The terminal chat event updates the visible transcript only. Sidebar
      // terminal marks are notification-backed, so a focused current session
      // never creates its own unread completion marker.
      set((s) => ({
        runningSessions: { ...s.runningSessions, [envelope.sessionId]: false },
        pendingPermissions: clearSessionPermissions(
          s.pendingPermissions,
          envelope.sessionId,
        ),
        pendingAsks: clearSessionAsks(s.pendingAsks, envelope.sessionId),
        latestTurnResults:
          event.type === "error" && event.error.code === "TURN_ABORTED"
            ? withoutRecordKey(s.latestTurnResults, envelope.sessionId)
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
        void drainQueuedPrompts(envelope.sessionId);
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
      }
      if (event.state !== "awaiting_approval") {
        void drainQueuedPrompts(envelope.sessionId);
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
      } else if (event.type === "asktool_request") {
        set((state) => ({
          pendingAsks: enqueueAsk(state.pendingAsks, event.request),
        }));
      } else if (event.type === "agent_end") {
        void get().refreshSessions();
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
        break;
      case "asktool_request":
        set((state) => ({
          pendingAsks: enqueueAsk(state.pendingAsks, event.request),
        }));
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
      throw new Error("Plan approval is no longer available");
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

  openWorkPanel: () => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    const context = currentWorkPanelContext(state);
    set({
      workPanelOpen: true,
      workPanelContexts: {
        ...state.workPanelContexts,
        [sessionId]: { ...context, open: true },
      },
    });
  },

  toggleWorkPanel: () => {
    if (get().workPanelOpen) {
      get().collapseWorkPanel();
      return;
    }
    get().openWorkPanel();
  },

  openWorkPanelTabForSession: (sessionId, tab) => {
    if (!sessionId) return;
    set((state) => {
      const affectsVisibleSession =
        state.activeSessionId === sessionId &&
        (pendingSessionSelection === null ||
          pendingSessionSelection.id === sessionId);
      const context = affectsVisibleSession
        ? currentWorkPanelContext(state)
        : state.workPanelContexts[sessionId] ?? emptyWorkPanelContext();
      const next = openWorkPanelTabState(
        {
          tabs: context.tabs,
          activeTabId: context.activeTabId,
        },
        tab,
      );
      const fileRequest =
        tab.kind === "file" && tab.resource
          ? {
              path: tab.resource,
              seq: ++workPanelFileRequestSeq,
            }
          : context.fileRequest;
      const nextContext: WorkPanelContext = {
        open: true,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
        ...(affectsVisibleSession
          ? {
              workPanelOpen: true,
              workPanelTabs: next.tabs,
              activeWorkPanelTabId: next.activeTabId,
              workPanelFileRequest: fileRequest,
            }
          : {}),
      };
    });
  },
  openWorkPanelTab: (tab) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    get().openWorkPanelTabForSession(sessionId, tab);
  },
  activateWorkPanelTab: (tabId) => {
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = activateWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest =
        activeTab?.kind === "file" && activeTab.resource
          ? {
              path: activeTab.resource,
              seq: ++workPanelFileRequestSeq,
            }
          : state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        open: state.workPanelOpen,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  closeWorkPanelTab: (tabId) => {
    let closePanel = false;
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = closeWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      closePanel = next.activeTabId === null;
      const fileRequest =
        activeTab?.kind === "file" && activeTab.resource
          ? {
              path: activeTab.resource,
              seq: ++workPanelFileRequestSeq,
            }
          : state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        open: closePanel ? false : state.workPanelOpen,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelOpen: closePanel ? false : state.workPanelOpen,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  collapseWorkPanel: () => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId || !state.workPanelOpen) return;
    set({
      workPanelOpen: false,
      workPanelContexts: {
        ...state.workPanelContexts,
        [sessionId]: { ...currentWorkPanelContext(state), open: false },
      },
    });
  },
  resetWorkPanelContext: () => {
    set((state) => switchWorkPanelSession(state));
  },
  setWorkPanelWidth: (width) => {
    const committedWidth = Math.round(width);
    set({
      workPanelWidth: Math.max(
        WORK_PANEL_MIN_WIDTH,
        Math.min(WORK_PANEL_MAX_WIDTH, committedWidth),
      ),
    });
    saveWorkPanelWidth(get().workPanelWidth);
  },

  openFileInWorkPanel: (path) => {
    get().openWorkPanelTab(fileWorkPanelTab(path));
  },
  openUrlInWorkPanel: (url) => {
    get().openWorkPanelTab({ ...toolWorkPanelTab("browser"), resource: url });
  },

  clearComposerPrefill: () => set({ composerPrefill: null }),
}));

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
  if (state.runningSessions[id]) liveSessionTranscripts.add(id);
  cacheSessionTranscript(id, state.messages, state.sessionHistory[id]);
  if (state.retainedTranscripts[id] === state.messages) return;
  useAppStore.setState((current) =>
    current.activeSessionId === id
      ? recordPaneTranscript(current, id, current.messages)
      : {},
  );
});

function drainQueuedPrompts(sessionId: string): Promise<void> {
  const active = queuedPromptDrains.get(sessionId);
  if (active) return active;
  const drain = (async () => {
    while (!useAppStore.getState().runningSessions[sessionId]) {
      const item = useAppStore.getState().queuedPrompts[sessionId]?.[0];
      if (!item) break;
      useAppStore.setState((state) => ({
        queuedPrompts: removeQueuedPrompt(
          state.queuedPrompts,
          sessionId,
          item.id,
        ),
      }));
      const accepted = await useAppStore
        .getState()
        .sendPrompt(item.content, item.draft, sessionId);
      if (!accepted) {
        useAppStore.setState((state) => ({
          queuedPrompts: enqueueQueuedPrompt(state.queuedPrompts, {
            ...item,
            sendNowRequested: undefined,
          }),
        }));
        break;
      }
    }
  })();
  queuedPromptDrains.set(sessionId, drain);
  void drain.finally(() => {
    if (queuedPromptDrains.get(sessionId) === drain) {
      queuedPromptDrains.delete(sessionId);
    }
  });
  return drain;
}

function flushPendingSessionConfiguration(sessionId: string): Promise<void> {
  const active = sessionConfigurationFlushes.get(sessionId);
  if (active) return active;
  if (useAppStore.getState().runningSessions[sessionId]) {
    return Promise.resolve();
  }

  const flush = (async () => {
    while (!useAppStore.getState().runningSessions[sessionId]) {
      const config = pendingSessionConfigurations.get(sessionId);
      if (!config) break;
      pendingSessionConfigurations.delete(sessionId);
      try {
        const result = await api.configureSession(sessionId, config);
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
      }
    }
  })();
  sessionConfigurationFlushes.set(sessionId, flush);
  void flush.finally(() => {
    if (sessionConfigurationFlushes.get(sessionId) === flush) {
      sessionConfigurationFlushes.delete(sessionId);
    }
    if (
      pendingSessionConfigurations.has(sessionId) &&
      !useAppStore.getState().runningSessions[sessionId]
    ) {
      void flushPendingSessionConfiguration(sessionId);
    }
  });
  return flush;
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
