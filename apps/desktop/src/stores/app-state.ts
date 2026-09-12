import type {
  AgentEventEnvelope,
  AgentQueueChangedEvent,
  AgentStatus,
  AppNotification,
  AppSettings,
  AppVersionInfo,
  AskToolResolution,
  ContextCompactionMark,
  Mode,
  ModelInfo,
  OnboardingState,
  PermissionMode,
  PlanProposal,
  PlanResolveRequest,
  PlanResolutionResult,
  PlanningState,
  PlanningStateEvent,
  PluginSummary,
  PluginTheme,
  PluginViewMeta,
  ProjectWorkspace,
  ProviderPublic,
  ReviewRollbackResult,
  SessionSummary,
  ThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";
import type { SettingsTabId } from "../lib/settings-search";
import type {
  ProjectMeta,
  ProjectSort,
  SessionMeta,
  SessionSort,
} from "../lib/sidebar-preferences";
import type { PermissionQueues } from "../lib/pending-permissions";
import type { AskQueues } from "../lib/pending-asks";
import type { QueuedPrompts } from "../lib/queued-prompts";
import type { SubagentPanelSelection } from "../lib/subagent-panel";
import type {
  ComposerDraftSnapshot,
  ComposerPrefill,
} from "../lib/composer-smart-stop";
import type { SidebarSessionOutcome } from "../lib/sidebar-session-status";
import type { WorkPanelContext, WorkPanelTab } from "../lib/work-panel-tabs";

export type { WorkPanelTab } from "../lib/work-panel-tabs";

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

export type SessionHistoryWindow = {
  messageStart: number;
  hasMoreBefore: boolean;
};

export type NavigationOptions = {
  /** Reuse an owning navigation's generation across nested async operations. */
  navigationIntent?: number;
};

export type RefreshSessionsOptions = {
  /** Restore archived project presentation state for newly imported sessions. */
  revealImportedProjects?: boolean;
};

/** Toolbar selections retained on the unpersisted new-task draft. */
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
  createProjectDialogOpen: boolean;
  activeProjectPath?: string;
  projectMeta: Record<string, ProjectMeta>;
  /** Kept as a flat map for lightweight consumers (Sidebar). */
  projectCollapsed: Record<string, boolean>;
  projectSort: ProjectSort;
  activeSessionId?: string;
  /** Composer toolbar choices retained on the draft while it has no session. */
  draftConfiguration: DraftSessionConfiguration | null;
  /** Latest user-selected session while its transcript/workspace is resolving. */
  selectingSessionId?: string;
  messages: UiMessage[];
  /** Session ids whose panes stay mounted, most recently visible first. */
  retainedSessionIds: string[];
  /** Last transcript each retained pane painted. */
  retainedTranscripts: Record<string, UiMessage[]>;
  /** Renderer-owned range metadata for the lazily loaded active transcript. */
  sessionHistory: Record<string, SessionHistoryWindow>;
  isRunning: boolean;
  /** Run state per session id — sessions run independent agents. */
  runningSessions: Record<string, boolean>;
  /** Runtime-owned phase for explaining quiet intervals in active turns. */
  agentStatuses: Record<string, AgentStatus>;
  /** Latest in-memory result for each session, used by the active transcript. */
  latestTurnResults: Record<string, AgentTurnResult>;
  /** Latest terminal outcome per session for compact sidebar feedback. */
  sessionOutcomes: Record<string, SidebarSessionOutcome>;
  /** Every checkpoint a session has installed, oldest first. */
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
  /** Per-session permission queue, oldest first. */
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
  /** Tab ids come from the shared settings index. */
  settingsTab: SettingsTabId;
  /** Pending row anchor (i18n key) to flash after landing on a settings tab. */
  settingsAnchor: string | null;
  navStack: Array<{ page: AppState["page"]; sessionId?: string }>;
  navIndex: number;
  error?: string | null;
  errorCode?: string | null;
  /** Whether the current error is worth a one-click retry. */
  errorRetriable?: boolean | null;
  bootstrap: () => Promise<void>;
  refreshSessions: (options?: RefreshSessionsOptions) => Promise<void>;
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
  refreshQueuedPrompts: (sessionId: string) => Promise<void>;
  applyQueueChanged: (event: AgentQueueChangedEvent) => void;
  compactContext: () => Promise<void>;
  retryAssistantMessage: (messageId: string) => Promise<void>;
  /** Replace a user prompt and regenerate from it. */
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
  closeProjectDialog: () => void;
  createProjectFromFolders: (input: {
    name: string;
    folders: string[];
    primaryPath: string;
  }) => Promise<void>;
  cloneProject: (url: string) => Promise<ProjectWorkspace | null>;
  /** Re-read the active workspace metadata without changing the visible project. */
  refreshProject: (path: string) => Promise<ProjectWorkspace | null>;
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
  /** Move an idle session into an already-known project, preserving history. */
  moveSessionProject: (id: string, projectPath: string) => Promise<boolean>;
  deleteSession: (id: string) => Promise<void>;
  setSessionSort: (sort: SessionSort) => void;
  setSessionArchiveVisibility: (show: boolean) => void;
  setSessionView: (view: Partial<SessionView> | boolean) => void;
  setShowArchived: (show: boolean) => void;
  renameProject: (path: string, name: string) => void;
  toggleProjectPinned: (path: string, pinned?: boolean) => void;
  toggleProjectArchived: (path: string) => void;
  restoreProject: (path: string) => void;
  restoreProjects: (paths: string[]) => void;
  archiveProject: (path: string) => void;
  setProjectCollapsed: (path: string, collapsed?: boolean) => void;
  toggleProjectCollapsed: (path: string) => void;
  closeProject: (path: string) => Promise<void>;
  setProjectSort: (sort: ProjectSort) => void;
  reorderProjects: (paths: string[]) => void;
  getVisibleSessions: (options?: {
    projectPath?: string | null;
    includeArchived?: boolean;
  }) => SessionSummary[];
  getSortedProjects: () => ProjectWorkspace[];
  refreshProviders: () => Promise<void>;
  /** Load a provider's model list into the cache (no-op when cached). */
  loadProviderModels: (providerId: string) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  /** Reload contributed themes. */
  refreshPluginThemes: () => Promise<void>;
  /** Reload contributed work panel views. */
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
  /** Renderer-only subagent details selected from the transcript. */
  subagentPanel: SubagentPanelSelection | null;
  workPanelOpen: boolean;
  workPanelTabs: WorkPanelTab[];
  activeWorkPanelTabId: string | null;
  /** Runtime-only work panel state owned by each conversation. */
  workPanelContexts: Record<string, WorkPanelContext>;
  workPanelWidth: number;
  /** Chat-initiated "preview this file" request consumed by the files viewer. */
  workPanelFileRequest: { path: string; seq: number; mimeType?: string } | null;
  /** Toggle the selected subagent detail. */
  toggleSubagentPanel: (delegationId: string) => void;
  closeSubagentPanel: () => void;
  openWorkPanel: () => void;
  toggleWorkPanel: () => void;
  openWorkPanelTab: (tab: WorkPanelTab) => void;
  /** Create and activate a new blank tool launcher page. */
  openNewWorkPanelTab: () => void;
  /** Open a tool from a blank launcher page, reusing an existing tool tab. */
  replaceWorkPanelTab: (sourceTabId: string, tab: WorkPanelTab) => void;
  openWorkPanelTabForSession: (sessionId: string, tab: WorkPanelTab) => void;
  activateWorkPanelTab: (tabId: string) => void;
  closeWorkPanelTab: (tabId: string) => void;
  collapseWorkPanel: () => void;
  /** Hide the visible panel while retaining its session-owned context. */
  resetWorkPanelContext: () => void;
  setWorkPanelWidth: (width: number) => void;
  openFileInWorkPanel: (path: string, mimeType?: string) => void;
  openUrlInWorkPanel: (url: string) => void;
};

export type AppStateData = {
  [Key in keyof AppState as AppState[Key] extends (
    ...args: never[]
  ) => unknown
    ? never
    : Key]: AppState[Key];
};

export type SessionView = {
  sort: SessionSort;
  /** Alias retained for sidebar consumers that use the explicit name. */
  sortBy?: SessionSort;
  /** Whether archived sessions are included in sidebar queries. */
  archived: boolean;
  showArchived?: boolean;
};
