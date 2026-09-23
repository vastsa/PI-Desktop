import type {
  ScheduledTaskRun,
  ActivationScope,
  AgentCapabilityMove,
  AgentCapabilityQuery,
  AgentEventEnvelope,
  AgentCompactRequest,
  AgentCompactResponse,
  AgentPromptRequest,
  AgentSteerRequest,
  UiMessage,
  MessageRevisionSummary,
  AgentPromptResponse,
  PromptEnhancementRequest,
  PromptEnhancementResponse,
  SpeechStatus,
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
  SessionSummarizeTitleRequest,
  SessionSummarizeTitleResponse,
  AgentStopResponse,
  AgentQueueChangedEvent,
  AgentQueuePushRequest,
  QueuedTurnSummary,
  AgentStatus,
  AskToolResolution,
  AgentInstructionFile,
  AppSettings,
  CommandShellCatalog,
  AppVersionInfo,
  BrowserAction,
  BrowserState,
  CommandItem,
  ComposerCommand,
  ComposerPasteFile,
  ComposerPastedFile,
  FsChatRefResolveResult,
  FsEntry,
  FsImageDataUrlResult,
  FsIndexResult,
  FsReadResult,
  HostHealth,
  HostStatusEvent,
  MarketSource,
  McpCatalogEntry,
  SkillCatalogEntry,
  ModelInfo,
  McpServerInput,
  McpServerRecord,
  McpServerStatus,
  McpOAuthLoginEvent,
  OnboardingState,
  OAuthLoginEvent,
  OAuthRespondInput,
  OAuthStartResult,
  OAuthVendor,
  PluginSummary,
  PluginPermissionReview,
  PluginSettingDefinition,
  PluginServiceStatus,
  PluginViewMeta,
  PluginScenicThemesDestinationMeta,
  PluginTheme,
  MarketPluginSummary,
  MarketPluginDetail,
  PluginInstallResult,
  PluginInstallProgress,
  ProjectRecord,
  ProjectGroupRecord,
  ProjectMemory,
  ProjectMemoryEntry,
  ProjectWorkspace,
  PullRequestSummary,
  ScheduledTask,
  ProviderCreateInput,
  ProviderPublic,
  ProviderReorderInput,
  ProviderUpdateInput,
  Result,
  SessionDetail,
  SessionSearchPage,
  SessionSearchContext,
  SessionSearchContextRequest,
  SessionSummary,
  SessionCollaborationSummary,
  TraySessionPreferences,
  ToolPermissionResolution,
  UserSkillInput,
  UserSkillRecord,
  UserSubagentInput,
  UserSubagentRecord,
  SubagentDefinition,
  WorkspaceDiff,
  AppMenuCommand,
  AppNotification,
  NativeMenuAction,
  NotificationListResult,
  ReviewRollbackResult,
  PlanProposal,
  PlanResolveRequest,
  PlanResolutionResult,
  PlanningStateEvent,
  PlansPendingResult,
  RemoteHostBootstrapRequest,
  RemoteHostBootstrapResult,
  RemoteHostPairRequest,
  RemoteHostPairResult,
  RemoteHostSummary,
  UpdateState,
  WindowControlAction,
  CloseBehavior,
  ConfigSyncApprovalInput,
  ConfigSyncChangePasswordInput,
  ConfigSyncHistoryEntry,
  ConfigSyncMapProjectInput,
  ConfigSyncConfigureInput,
  ConfigSyncRestoreInput,
  ConfigSyncProgress,
  ConfigSyncState,
  TrustedExtensionStatusEvent,
  TrustedExtensionUiPrompt,
  TrustedExtensionUiPromptResponse,
} from "@pi-desktop/shared";
import {
  defaultCommandShellForPlatform,
  IPC,
  isCommandShellId,
  normalizeLargePasteThreshold,
  normalizeMode,
  normalizeNetworkProxy,
  normalizeNetworkPolicy,
  resolveFontScale,
  normalizeChatContentMaxWidth,
  validateNetworkPolicy,
  validateNetworkProxy,
  validateSpeechSettings,
} from "@pi-desktop/shared";

export type ImportSource = "claude-code" | "opencode" | "codex" | "pi";
// One definition, owned by the shared package (the host and sidecar use the
// same shape); re-exported so existing renderer imports keep working.
import type {
  ModelConfigImportCandidate,
  ModelConfigImportSource,
} from "@pi-desktop/shared";
export type { ModelConfigImportCandidate, ModelConfigImportSource };

export interface ImportCandidate {
  source: ImportSource;
  externalId: string;
  title: string;
  projectPath: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /** null when the source file was too large to scan without sampling. */
  messageCount: number | null;
}

export interface ImportRunResult {
  imported: number;
  skipped: number;
  failed: number;
}

// --- External skill / MCP scan-and-import ---------------------------------
// Renderer-side mirrors of the electron-main scanner output so the panel does
// not have to import from `electron/`. Keep the field names in sync with
// `apps/desktop/electron/main/importers/agent-*-scan.ts`.

export type ExternalSkillSourceKind =
  | "claude-user"
  | "claude-project"
  | "pi-user"
  | "pi-project";

export interface ExternalSkillCandidate {
  source: ExternalSkillSourceKind;
  sourcePath: string;
  rootDir?: string;
  shape: "file" | "dir";
  id: string;
  name: string;
  description: string;
  bytes: number;
  warnings: string[];
}

export interface ExternalSkillSourceReport {
  kind: ExternalSkillSourceKind | "error";
  path: string;
  exists: boolean;
  error?: string;
  count: number;
}

export interface ExternalSkillScanResult {
  candidates: ExternalSkillCandidate[];
  sources: ExternalSkillSourceReport[];
}

export interface ExternalSkillImportItem {
  source: ExternalSkillSourceKind;
  sourcePath: string;
  shape: "file" | "dir";
  rootDir?: string;
  id: string;
  name: string;
  description?: string;
}

export interface ExternalSkillImportPayload {
  level: "global" | "project";
  projectPath?: string;
  mode?: "copy" | "link";
  items: ExternalSkillImportItem[];
}

export interface ExternalSkillImportRunResult {
  imported: Array<{ item: ExternalSkillImportItem; skill: UserSkillRecord }>;
  skipped: Array<{ item: ExternalSkillImportItem; reason: string }>;
  failed: Array<{ item: ExternalSkillImportItem; error: string }>;
}

export type ExternalMcpSourceKind =
  | "claude-desktop"
  | "claude-code"
  | "cursor-global"
  | "cursor-project"
  | "codex"
  | "opencode"
  | "chatgpt-desktop";

export interface ExternalMcpCandidate {
  source: ExternalMcpSourceKind;
  sourcePath: string;
  id: string;
  rawKey: string;
  label?: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  warnings: string[];
}

export interface ExternalMcpSourceReport {
  kind: ExternalMcpSourceKind | "error";
  path: string;
  exists: boolean;
  error?: string;
  count: number;
}

export interface ExternalMcpScanResult {
  candidates: ExternalMcpCandidate[];
  sources: ExternalMcpSourceReport[];
}

export interface ExternalMcpImportItem {
  source: ExternalMcpSourceKind;
  sourcePath: string;
  id: string;
  rawKey: string;
  label?: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface ExternalMcpImportPayload {
  items: ExternalMcpImportItem[];
}

export interface ExternalMcpImportRunResult {
  imported: Array<{ item: ExternalMcpImportItem; server: McpServerRecord }>;
  skipped: Array<{ item: ExternalMcpImportItem; reason: string }>;
  failed: Array<{ item: ExternalMcpImportItem; error: string }>;
}

declare global {
  interface Window {
    piDesktop?: {
      invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<Result<T>>;
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
      channels: typeof IPC;
      platform: NodeJS.Platform;
      /** Authoritative OS locale passed from the main process at window creation. */
      locale?: string;
      /** Resolve a native dropped File to its source path. */
      getDroppedFilePath?: (file: File) => string | null;
    };
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.piDesktop?.invoke) {
    throw new Error("piDesktop preload bridge unavailable");
  }
  const result = await window.piDesktop.invoke<T>(channel, ...args);
  if (!result.ok) {
    const error = new Error(result.error.message) as Error & {
      code?: string;
      details?: unknown;
    };
    error.code = result.error.code;
    error.details = result.error.details;
    throw error;
  }
  return result.data;
}

function normalizeSession(session: SessionSummary): SessionSummary {
  return {
    ...session,
    source: session.source ?? "desktop",
    mode: normalizeMode((session as { mode?: unknown }).mode),
  };
}

function normalizeSessionDetail(detail: SessionDetail | null): SessionDetail | null {
  return detail
    ? {
        ...detail,
        mode: normalizeMode((detail as { mode?: unknown }).mode),
      }
    : null;
}

export type SessionHistoryReadOptions = {
  /** Center a bounded read on this stable ID and retain its original text. */
  messageAround?: string;
  /** Return the newest page ending before this zero-based message offset. */
  messageBefore?: number;
  /** Maximum number of messages in the returned page. */
  messageLimit?: number;
  /** Maximum characters per displayed message/value field. */
  contentLimit?: number;
};

export function normalizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    defaultMode: normalizeMode((settings as { defaultMode?: unknown }).defaultMode),
    infiniteProviderRetry:
      (settings as { infiniteProviderRetry?: unknown }).infiniteProviderRetry === true,
    defaultCommandShell: isCommandShellId(
      (settings as { defaultCommandShell?: unknown }).defaultCommandShell,
    )
      ? (settings as { defaultCommandShell: AppSettings["defaultCommandShell"] })
          .defaultCommandShell
      : defaultCommandShellForPlatform(window.piDesktop?.platform ?? ""),
    largePasteThreshold: normalizeLargePasteThreshold(
      (settings as { largePasteThreshold?: unknown }).largePasteThreshold,
    ),
    fontScale: resolveFontScale(settings),
    networkProxy: normalizeNetworkProxy(
      (settings as { networkProxy?: unknown }).networkProxy,
    ),
    networkPolicy: normalizeNetworkPolicy(
      (settings as { networkPolicy?: unknown }).networkPolicy,
    ),
  };
}

export function validateSettingsWrite(settings: AppSettings): AppSettings {
  if (
    settings.thinkingDisplayMode !== undefined &&
    settings.thinkingDisplayMode !== "detailed" &&
    settings.thinkingDisplayMode !== "compact"
  ) {
    throw Object.assign(new Error("thinkingDisplayMode is invalid"), {
      errorCode: "INVALID_PARAMS",
    });
  }
  const value = settings as AppSettings & {
    defaultCommandShell?: unknown;
    largePasteThreshold?: unknown;
    fontScale?: unknown;
    chatContentMaxWidth?: unknown;
    infiniteProviderRetry?: unknown;
    networkProxy?: unknown;
    networkPolicy?: unknown;
  };
  if (
    Object.prototype.hasOwnProperty.call(value, "defaultCommandShell") &&
    !isCommandShellId(value.defaultCommandShell)
  ) {
    throw Object.assign(new Error("defaultCommandShell is invalid"), {
      errorCode: "COMMAND_SHELL_INVALID",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "largePasteThreshold") &&
    normalizeLargePasteThreshold(value.largePasteThreshold) !==
      value.largePasteThreshold
  ) {
    throw Object.assign(new Error("largePasteThreshold is invalid"), {
      errorCode: "INVALID_PARAMS",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "fontScale") &&
    resolveFontScale({ fontScale: value.fontScale }) !== value.fontScale
  ) {
    throw Object.assign(new Error("fontScale is invalid"), {
      errorCode: "INVALID_PARAMS",
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, "chatContentMaxWidth")) {
    const next = normalizeChatContentMaxWidth(value.chatContentMaxWidth);
    if (next === undefined || next !== value.chatContentMaxWidth) {
      throw Object.assign(new Error("chatContentMaxWidth is invalid"), {
        errorCode: "INVALID_PARAMS",
      });
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "infiniteProviderRetry") &&
    typeof value.infiniteProviderRetry !== "boolean"
  ) {
    throw Object.assign(new Error("infiniteProviderRetry is invalid"), {
      errorCode: "INVALID_PARAMS",
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, "networkProxy")) {
    const proxy = validateNetworkProxy(value.networkProxy);
    if (!proxy.ok) {
      throw Object.assign(new Error(proxy.error), {
        errorCode: "INVALID_ARGUMENT",
      });
    }
    value.networkProxy = proxy.value;
  }
  if (Object.prototype.hasOwnProperty.call(value, "networkPolicy")) {
    const policy = validateNetworkPolicy(value.networkPolicy);
    if (!policy.ok) {
      throw Object.assign(new Error(policy.error), {
        errorCode: "INVALID_ARGUMENT",
      });
    }
    value.networkPolicy = policy.value;
  }
  if (Object.prototype.hasOwnProperty.call(value, "speech")) {
    (value as AppSettings).speech = validateSpeechSettings(
      (value as { speech?: unknown }).speech,
    );
  }
  return settings;
}

function normalizePlanProposal(proposal: PlanProposal): PlanProposal {
  return { ...proposal };
}

function normalizePendingPlans(result: PlansPendingResult): PlansPendingResult {
  return {
    ...result,
    plans: result.plans.map(normalizePlanProposal),
  };
}

function normalizePlansChangedEvent(value: unknown): PlanningStateEvent {
  const raw = (value ?? {}) as PlanningStateEvent & {
    execution?: {
      id?: unknown;
      proposalId?: unknown;
      state?: unknown;
    };
  };
  const execution = raw.execution;
  if (!execution) return raw;
  const executionState =
    execution.state === "queued" ||
    execution.state === "running" ||
    execution.state === "completed" ||
    execution.state === "interrupted"
      ? execution.state
      : undefined;
  return {
    ...raw,
    ...(raw.proposalId || typeof execution.proposalId !== "string"
      ? {}
      : { proposalId: execution.proposalId }),
    ...(raw.executionId || typeof execution.id !== "string"
      ? {}
      : { executionId: execution.id }),
    ...(raw.executionState || !executionState
      ? {}
      : { executionState }),
  };
}

export const api = {
  getVersion: () => invoke<AppVersionInfo>(IPC.invoke.appGetVersion),
  health: () => invoke<HostHealth>(IPC.invoke.appHealth),
  getOnboarding: () => invoke<OnboardingState>(IPC.invoke.appGetOnboarding),
  dismissOnboarding: () => invoke(IPC.invoke.appDismissOnboarding),
  updatesGetState: () => invoke<UpdateState>(IPC.invoke.updatesGetState),
  updatesCheck: () => invoke<UpdateState>(IPC.invoke.updatesCheck),
  updatesDownload: () => invoke<UpdateState>(IPC.invoke.updatesDownload),
  updatesInstall: () => invoke(IPC.invoke.updatesInstall),
  updatesOpenReleases: () => invoke(IPC.invoke.updatesOpenReleases),
  openFeedback: () => invoke(IPC.invoke.appOpenFeedback),
  listNotifications: (input?: { unreadOnly?: boolean; limit?: number }) =>
    invoke<NotificationListResult>(IPC.invoke.notificationList, input ?? {}),
  markNotificationRead: (id: string) =>
    invoke<{ ok: boolean }>(IPC.invoke.notificationMarkRead, { id }),
  markAllNotificationsRead: () =>
    invoke<{ ok: boolean }>(IPC.invoke.notificationMarkAllRead),
  clearNotifications: () =>
    invoke<{ ok: boolean }>(IPC.invoke.notificationClear),
  showNativeNotification: (input: {
    id: string;
    sessionId: string;
    kind: "task" | "interactive";
    title: string;
    body: string;
  }) => invoke<{ shown: boolean }>(IPC.invoke.notificationShowNative, input),
  setNotificationViewingSession: (sessionId: string | null) =>
    invoke<{ ok: boolean }>(IPC.invoke.notificationSetViewingSession, {
      sessionId,
    }),
  listSessions: () =>
    invoke<{ sessions: SessionSummary[] }>(IPC.invoke.sessionList).then((result) => ({
      ...result,
      sessions: result.sessions.map(normalizeSession),
    })),
  createSession: (input?: Partial<SessionSummary>) =>
    invoke<{ session: SessionSummary }>(IPC.invoke.sessionCreate, input ?? {}).then(
      (result) => ({ ...result, session: normalizeSession(result.session) }),
    ),
  forkSession: (sessionId: string, title?: string, throughMessageId?: string) =>
    invoke<{ session: SessionDetail }>(IPC.invoke.sessionFork, {
      sessionId,
      title,
      throughMessageId,
    }).then((result) => ({ ...result, session: normalizeSessionDetail(result.session)! })),
  searchSessions: (query: string, offset = 0) =>
    invoke<SessionSearchPage>(IPC.invoke.sessionSearch, { query, offset }),
  getSearchContext: (request: SessionSearchContextRequest) =>
    invoke<SessionSearchContext>(IPC.invoke.sessionSearchContext, request),
  getSession: (id: string, options?: SessionHistoryReadOptions) =>
    invoke<{ session: SessionDetail | null }>(IPC.invoke.sessionGet, {
      id,
      ...(options ?? {}),
    }).then((result) => ({
      ...result,
      session: normalizeSessionDetail(result.session),
    })),
  getSessionCollaboration: (sessionId: string) =>
    invoke<SessionCollaborationSummary>(IPC.invoke.sessionCollaboration, { sessionId }),
  deleteSession: (id: string) => invoke(IPC.invoke.sessionDelete, id),
  getSessionScratchPath: (sessionId: string) =>
    invoke<{ path: string }>(IPC.invoke.sessionGetScratchPath, { sessionId }),
  openSessionScratchPath: (sessionId: string) =>
    invoke<{ ok: boolean; path: string }>(IPC.invoke.sessionOpenScratchPath, {
      sessionId,
    }),
  openProjectFolder: (path: string) =>
    invoke<{ ok: boolean; path: string }>(IPC.invoke.projectOpenFolder, path),
  renameSession: (id: string, title: string) =>
    invoke<{ ok: boolean }>(IPC.invoke.sessionRename, id, title),
  moveSessionProject: (sessionId: string, projectPath: string) =>
    invoke<{ session: SessionSummary }>(IPC.invoke.sessionMoveProject, {
      sessionId,
      projectPath,
    }).then((result) => ({ ...result, session: normalizeSession(result.session) })),
  summarizeSessionTitle: (req: SessionSummarizeTitleRequest) =>
    invoke<SessionSummarizeTitleResponse>(IPC.invoke.sessionSummarizeTitle, req),
  configureSession: (
    id: string,
    config: Pick<SessionSummary, "mode" | "providerId" | "modelId"> &
      Partial<Pick<SessionSummary, "thinkingLevel" | "permissionMode">>,
  ) =>
    invoke<{ session: SessionSummary }>(
      IPC.invoke.sessionConfigure,
      id,
      config,
    ).then((result) => ({ ...result, session: normalizeSession(result.session) })),
  scanImportSessions: () =>
    invoke<{
      sessions: ImportCandidate[];
      truncated?: Partial<Record<ImportSource, number>>;
    }>(IPC.invoke.sessionImportScan),

  runImportSessions: (items: ImportCandidate[]) =>
    invoke<ImportRunResult>(IPC.invoke.sessionImportRun, items),
  scanImportModelConfigs: () =>
    invoke<{ providers: ModelConfigImportCandidate[] }>(
      IPC.invoke.modelConfigImportScan,
    ),
  runImportModelConfigs: (items: ModelConfigImportCandidate[]) =>
    invoke<ImportRunResult>(IPC.invoke.modelConfigImportRun, items),
  getSettings: () => invoke<AppSettings>(IPC.invoke.settingsGet).then(normalizeSettings),
  setSettings: (settings: AppSettings) =>
    invoke(IPC.invoke.settingsSet, validateSettingsWrite(settings)),
  configSyncGetState: () => invoke<ConfigSyncState>(IPC.invoke.configSyncGetState),
  configSyncConfigure: (input: ConfigSyncConfigureInput) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncConfigure, input),
  configSyncTest: (input: Omit<ConfigSyncConfigureInput, "backupPassword"> & { backupPassword?: string }) =>
    invoke<{
      ok: boolean;
      conditionalWrites: boolean;
      appendOnly: boolean;
      message?: string;
    }>(
      IPC.invoke.configSyncTest,
      input,
    ),
  configSyncSyncNow: () => invoke<ConfigSyncState>(IPC.invoke.configSyncSyncNow),
  configSyncPause: (paused: boolean) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncPause, { paused }),
  configSyncUnlock: (backupPassword: string) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncUnlock, { backupPassword }),
  configSyncApprove: (input: ConfigSyncApprovalInput) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncApprove, input),
  configSyncReject: (input: ConfigSyncApprovalInput) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncReject, input),
  configSyncMapProject: (input: ConfigSyncMapProjectInput) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncMapProject, input),
  configSyncListHistory: () =>
    invoke<ConfigSyncHistoryEntry[]>(IPC.invoke.configSyncListHistory),
  configSyncRestore: (input: ConfigSyncRestoreInput) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncRestore, input),
  configSyncChangePassword: (input: ConfigSyncChangePasswordInput) =>
    invoke<ConfigSyncState>(IPC.invoke.configSyncChangePassword, input),
  configSyncDisconnect: () => invoke<ConfigSyncState>(IPC.invoke.configSyncDisconnect),
  testNetworkProxy: (settings: unknown) =>
    invoke<{ ok: boolean; error?: string }>(IPC.invoke.networkProxyTest, settings),
  /** Installed system font families (Electron main, cached briefly). */
  listSystemFonts: () => invoke<string[]>(IPC.invoke.systemFontsList),
  listCommandShells: () =>
    invoke<CommandShellCatalog>(IPC.invoke.commandShellList),
  reorderProviders: (input: ProviderReorderInput) =>
    invoke<{ ok: boolean }>(IPC.invoke.providersReorder, input),
  listProviders: () =>
    invoke<{ providers: ProviderPublic[] }>(IPC.invoke.providersList),
  createProvider: (input: ProviderCreateInput) =>
    invoke<{ provider: ProviderPublic }>(IPC.invoke.providersCreate, input),
  updateProvider: (input: ProviderUpdateInput) =>
    invoke<{ provider: ProviderPublic | null }>(
      IPC.invoke.providersUpdate,
      input,
    ),
  deleteProvider: (id: string) => invoke(IPC.invoke.providersDelete, id),
  /**
   * Set or clear one provider's API key. The only write a plugin-declared row
   * accepts from the user path, since `updateProvider` refuses it.
   */
  setProviderSecret: (input: { id: string; secretValue?: string }) =>
    invoke<{ provider: ProviderPublic | null }>(
      IPC.invoke.providersSetSecret,
      input,
    ),
  testProvider: (id: string) => invoke(IPC.invoke.providersTest, id),
  /**
   * Discover models from the provider's own endpoint. Saved providers pass
   * providerId (stored secret is reused); the setup form may pass raw config
   * before the provider exists.
   *
   * `source` reports where the list came from: `remote` is the service's own
   * answer, `catalog` means the endpoint published nothing and models.dev was
   * used instead, `cache` is the local table, `fallback` is just the configured
   * model id.
   */
  listProviderModels: (input: {
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
    apiStyle?: string;
    headers?: Record<string, string>;
    source?: "cache" | "refresh";
  }) =>
    invoke<{
      models: ModelInfo[];
      source: "cache" | "remote" | "catalog" | "fallback";
      error?: string;
    }>(IPC.invoke.providersListModels, input),
  /**
   * Look one hand-typed model id up in the local models.dev snapshot.
   *
   * The discovered list only describes ids a service already serves, so this is
   * the only way a custom id reaches its published limits before the provider
   * is saved. Snapshot read only: no provider network access and no host call.
   * `info` is null when the catalog does not publish the id.
   */
  lookupProviderModel: (input: {
    modelId: string;
    baseUrl?: string;
    providerId?: string;
    vendorKey?: string;
  }) =>
    invoke<{ info: ModelInfo | null }>(IPC.invoke.providersLookupModel, input),
  /** Force-refresh models.dev for the running process; release snapshots are bundled. */
  refreshModelCatalog: () =>
    invoke<{
      refreshed: boolean;
      status: {
        loaded: boolean;
        source: "bundled" | "remote" | "empty";
        catalogPath: string;
        fetchedAt?: string;
        providerCount: number;
        modelCount: number;
        lastError?: string;
      };
    }>(IPC.invoke.providersRefreshModelCatalog),
  /** models.dev snapshot status for the settings footer; performs no network I/O. */
  modelCatalogStatus: () =>
    invoke<{
      status: {
        loaded: boolean;
        source: "bundled" | "remote" | "empty";
        catalogPath: string;
        fetchedAt?: string;
        providerCount: number;
        modelCount: number;
        lastError?: string;
      };
    }>(IPC.invoke.providersModelCatalogStatus),
  /** Vendor catalog plus every locally configured account for each vendor. */
  listOauthVendors: () =>
    invoke<{ vendors: OAuthVendor[] }>(IPC.invoke.providersOauthVendors),
  /** Begin a login; progress arrives through `onOauthLogin`. */
  startOauthLogin: (vendorId: string) =>
    invoke<OAuthStartResult>(IPC.invoke.providersOauthStart, vendorId),
  /** Answer a prompt; omitting the value cancels the login. */
  respondOauthLogin: (input: OAuthRespondInput) =>
    invoke<{ ok: boolean }>(IPC.invoke.providersOauthRespond, input),
  cancelOauthLogin: (loginId: string) =>
    invoke<{ ok: boolean }>(IPC.invoke.providersOauthCancel, loginId),
  deleteOauthAccount: (providerId: string) =>
    invoke<{ ok: boolean }>(IPC.invoke.providersOauthDelete, providerId),
  getProject: () =>
    invoke<{ workspace: ProjectWorkspace | null }>(IPC.invoke.projectGet),
  listProjects: () =>
    invoke<{ projects: ProjectRecord[] }>(IPC.invoke.projectList),
  listProjectGroups: () =>
    invoke<{ groups: ProjectGroupRecord[] }>(IPC.invoke.projectGroupList),
  createProjectGroup: (name: string, folders: string[]) =>
    invoke<{ group: ProjectGroupRecord }>(IPC.invoke.projectGroupCreate, { name, folders }),
  renameProjectGroup: (groupId: string, name: string) =>
    invoke<{ group: ProjectGroupRecord }>(IPC.invoke.projectGroupRename, { groupId, name }),
  updateProjectGroup: (groupId: string, name: string, folders: string[]) =>
    invoke<{ group: ProjectGroupRecord }>(IPC.invoke.projectGroupUpdate, {
      groupId,
      name,
      folders,
    }),
  getProjectGroupMemory: (groupId: string) =>
    invoke<{ memory: ProjectMemory }>(IPC.invoke.projectGroupMemoryGet, { groupId }),
  saveProjectGroupMemory: (groupId: string, entries: ProjectMemory["entries"]) =>
    invoke<{ memory: ProjectMemory }>(IPC.invoke.projectGroupMemorySave, { groupId, entries }),
  getProjectGroupInstructions: (groupId: string) =>
    invoke<{ content: string }>(IPC.invoke.projectGroupInstructionsGet, { groupId }),
  saveProjectGroupInstructions: (groupId: string, content: string) =>
    invoke<{ content: string }>(IPC.invoke.projectGroupInstructionsSave, { groupId, content }),
  openProject: () =>
    invoke<{ workspace: ProjectWorkspace | null; canceled?: boolean }>(
      IPC.invoke.projectOpen,
    ),
  pickProjectFolders: () =>
    invoke<{ folders: string[]; canceled?: boolean }>(IPC.invoke.projectPickFolders),
  getProjectMemory: (projectPath: string) =>
    invoke<{ memory: ProjectMemory }>(IPC.invoke.projectMemoryGet, { projectPath }),
  saveProjectMemory: (projectPath: string, entries: ProjectMemoryEntry[]) =>
    invoke<{ memory: ProjectMemory }>(IPC.invoke.projectMemorySave, {
      projectPath,
      entries,
    }),
  cloneProject: (url: string) =>
    invoke<{ workspace: ProjectWorkspace | null; canceled?: boolean }>(
      IPC.invoke.projectClone,
      { url },
    ),
  cloneProjectInto: (url: string, parentPath: string) =>
    invoke<{ path: string; name: string }>(IPC.invoke.projectCloneCheckout, {
      url,
      parentPath,
    }),
  pickFiles: () =>
    invoke<{ token: string | null; canceled?: boolean }>(IPC.invoke.composerPickFiles),
  getDroppedFilePath: (file: File) =>
    window.piDesktop?.getDroppedFilePath?.(file) ?? null,
  pickPhotos: () =>
    invoke<{ token: string | null; canceled?: boolean }>(IPC.invoke.composerPickPhotos),
  importFiles: (sessionId: string, token: string) =>
    invoke<{ files: ComposerPastedFile[] }>(IPC.invoke.composerImportFiles, {
      sessionId,
      token,
    }),
  pasteFiles: (sessionId: string, files: ComposerPasteFile[]) =>
    invoke<{ files: ComposerPastedFile[] }>(IPC.invoke.composerPasteFiles, {
      sessionId,
      files,
    }),
  recordClipboardPaste: (text: string) =>
    invoke<{ ok: boolean }>(IPC.invoke.clipboardRecordPaste, { text }),
  clearProject: () => invoke(IPC.invoke.projectClear),
  removeProject: (path: string) =>
    invoke<{ removed: boolean; sessionsRemoved: number }>(
      IPC.invoke.projectRemove,
      { path },
    ),
  setProject: (path: string) =>
    invoke<{ workspace: ProjectWorkspace | null }>(IPC.invoke.projectSet, path),
  listPullRequests: () =>
    invoke<{ pulls: PullRequestSummary[]; error?: string }>(IPC.invoke.pullsList),
  listScheduled: () =>
    invoke<{ tasks: ScheduledTask[] }>(IPC.invoke.scheduledList),
  createScheduled: (input: {
    title?: string;
    prompt: string;
    cadence?: ScheduledTask["cadence"];
    enabled?: boolean;
    schedule?: ScheduledTask["schedule"];
    workspacePath?: string;
    permissionMode?: ScheduledTask["permissionMode"];
    thinkingLevel?: ScheduledTask["thinkingLevel"] | null;
    providerId?: string | null;
    modelId?: string | null;
  }) => invoke<{ task: ScheduledTask }>(IPC.invoke.scheduledCreate, input),
  updateScheduled: (
    input: Omit<Partial<ScheduledTask>, "providerId" | "modelId" | "thinkingLevel"> & {
      id: string;
      thinkingLevel?: ScheduledTask["thinkingLevel"] | null;
      providerId?: string | null;
      modelId?: string | null;
    },
  ) =>
    invoke<{ task: ScheduledTask }>(IPC.invoke.scheduledUpdate, input),
  deleteScheduled: (id: string) => invoke(IPC.invoke.scheduledDelete, id),
  executeScheduled: (id: string) => invoke<{ sessionId: string }>(IPC.invoke.scheduledExecute, id),
  listScheduledRuns: () => invoke<{ runs: ScheduledTaskRun[] }>(IPC.invoke.scheduledListRuns),
  runScheduled: (id: string) =>
    invoke<{ sessionId: string; prompt: string; task: ScheduledTask }>(
      IPC.invoke.scheduledRun,
      id,
    ),
  replaceSessionMessages: (sessionId: string, messages: UiMessage[]) =>
    invoke(IPC.invoke.sessionReplaceMessages, { sessionId, messages }),
  saveSessionRevision: (input: {
    sessionId: string;
    rootUserId: string;
    messages: UiMessage[];
    makeActive?: boolean;
  }) =>
    invoke<{ revision: MessageRevisionSummary }>(IPC.invoke.sessionSaveRevision, input),
  listSessionRevisions: (sessionId: string, rootUserId: string) =>
    invoke<{ revisions: MessageRevisionSummary[] }>(IPC.invoke.sessionListRevisions, {
      sessionId,
      rootUserId,
    }),
  activateSessionRevision: (input: {
    sessionId: string;
    rootUserId: string;
    revisionIndex: number;
    prefix: UiMessage[];
  }) =>
    invoke<{ messages: UiMessage[] }>(IPC.invoke.sessionActivateRevision, input),
  steer: (req: AgentSteerRequest) =>
    invoke<AgentPromptResponse>(IPC.invoke.agentSteer, req),
  prompt: (req: AgentPromptRequest) =>
    invoke<AgentPromptResponse>(IPC.invoke.agentPrompt, req),
  enhancePrompt: (req: PromptEnhancementRequest) =>
    invoke<PromptEnhancementResponse>(IPC.invoke.promptEnhance, req),
  speechStatus: () => invoke<SpeechStatus>(IPC.invoke.speechGetStatus),
  speechTranscribe: (req: SpeechTranscribeRequest) =>
    invoke<{ text: string }>(IPC.invoke.speechTranscribe, req),
  speechSynthesize: (req: SpeechSynthesizeRequest) =>
    invoke<SpeechSynthesizeResult>(IPC.invoke.speechSynthesize, req),
  compact: (req: AgentCompactRequest) =>
    invoke<AgentCompactResponse>(IPC.invoke.agentCompact, req),
  abort: (sessionId: string) =>
    invoke(IPC.invoke.agentAbort, { sessionId }),
  stop: (sessionId: string) =>
    invoke<AgentStopResponse>(IPC.invoke.agentStop, { sessionId }),
  queuePrompt: (req: AgentQueuePushRequest) =>
    invoke<QueuedTurnSummary>(IPC.invoke.agentQueuePush, req),
  listQueuedPrompts: (sessionId: string) =>
    invoke<{ entries: QueuedTurnSummary[] }>(IPC.invoke.agentQueueList, { sessionId }),
  removeQueuedPrompt: (turnId: string) =>
    invoke(IPC.invoke.agentQueueRemove, { turnId }),
  prioritizeQueuedPrompt: (turnId: string) =>
    invoke(IPC.invoke.agentQueuePrioritize, { turnId }),
  reorderQueuedPrompt: (turnId: string, direction: "up" | "down") =>
    invoke<{ moved: boolean }>(IPC.invoke.agentQueueReorder, { turnId, direction }),
  getStatus: (sessionId: string) =>
    invoke<{ status: AgentStatus }>(IPC.invoke.agentGetStatus, sessionId),
  getAgentInstructions: (projectPath?: string) =>
    invoke<{ global: AgentInstructionFile; project?: AgentInstructionFile }>(
      IPC.invoke.agentInstructionsGet,
      projectPath === undefined ? {} : { projectPath },
    ),
  saveAgentInstructions: (
    scope: AgentInstructionFile["scope"],
    content: string,
    projectPath?: string,
  ) =>
    invoke<{ file: AgentInstructionFile }>(IPC.invoke.agentInstructionsSave, {
      scope,
      content,
      ...(projectPath === undefined ? {} : { projectPath }),
    }),
  resolvePermission: (resolution: ToolPermissionResolution) =>
    invoke(IPC.invoke.toolResolvePermission, resolution),
  resolveAskTool: (resolution: AskToolResolution) =>
    invoke(IPC.invoke.askToolResolve, resolution),
  pendingPlans: (sessionId?: string) =>
    invoke<PlansPendingResult>(
      IPC.invoke.plansPending,
      sessionId ? { sessionId } : {},
    ).then(normalizePendingPlans),
  resolvePlan: (resolution: PlanResolveRequest) =>
    invoke<PlanResolutionResult>(IPC.invoke.plansResolve, resolution),
  listPlugins: () =>
    invoke<{ plugins: PluginSummary[] }>(IPC.invoke.pluginList),
  /**
   * Picking a folder only reports what it declares; the load happens in
   * `confirmLoadDevPlugin` once the user has seen that.
   */
  loadDevPlugin: () =>
    invoke<{ canceled?: boolean; review?: PluginPermissionReview }>(
      IPC.invoke.pluginLoadDev,
    ),
  confirmLoadDevPlugin: (input: { path: string; grantedPermissions: string[] }) =>
    invoke(IPC.invoke.pluginLoadDevConfirm, input),
  /**
   * A manifest that asks for more than the current approval comes back as a
   * `review` instead of a reload, so the page asks before anything is granted.
   */
  reloadPlugin: (id: string) =>
    invoke<{ review?: PluginPermissionReview }>(IPC.invoke.pluginReload, id),
  confirmReloadPlugin: (input: { id: string; grantedPermissions: string[] }) =>
    invoke(IPC.invoke.pluginReloadConfirm, input),
  createPluginFromTemplate: (template: string) =>
    invoke<{
      canceled?: boolean;
      id?: string;
      name?: string;
      dir?: string;
      files?: string[];
      review?: PluginPermissionReview;
    }>(IPC.invoke.pluginCreateFromTemplate, { template }),
  installPluginFromPath: () => invoke(IPC.invoke.pluginInstallFromPath),
  installPluginFromPackage: () => invoke(IPC.invoke.pluginInstallFromPackage),
  enablePlugin: (id: string) => invoke(IPC.invoke.pluginEnable, id),
  disablePlugin: (id: string) => invoke(IPC.invoke.pluginDisable, id),
  uninstallPlugin: (id: string) => invoke(IPC.invoke.pluginUninstall, id),
  setPluginAutoUpdate: (id: string, enabled: boolean) =>
    invoke(IPC.invoke.pluginSetAutoUpdate, { id, enabled }),
  getPluginSettings: (id: string) =>
    invoke<{ settings: PluginSettingDefinition[] }>(IPC.invoke.pluginSettingsGet, id),
  setPluginSettings: (id: string, settings: Record<string, unknown>) =>
    invoke<{ settings: PluginSettingDefinition[] }>(IPC.invoke.pluginSettingsSet, {
      id,
      settings,
    }),
  /**
   * Where a plugin's contributions apply. Separate from enable/disable so
   * narrowing a plugin to two projects and then switching it off keeps the list.
   */
  setPluginScope: (id: string, scope: ActivationScope) =>
    invoke<{ plugin?: PluginSummary }>(IPC.invoke.pluginSetScope, { id, scope }),

  // --- MCP servers the user owns -------------------------------------------
  listMcpServers: (query?: AgentCapabilityQuery) =>
    invoke<{ servers: McpServerRecord[]; statuses: McpServerStatus[] }>(
      IPC.invoke.mcpList,
      query,
    ),
  /** Create or replace a server; the id decides which level-local file. */
  upsertMcpServer: (server: McpServerInput) =>
    invoke<{ server: McpServerRecord }>(IPC.invoke.mcpUpsert, server),
  removeMcpServer: (
    id: string,
    query?: Partial<AgentCapabilityQuery>,
  ) => invoke(IPC.invoke.mcpRemove, { id, ...query }),
  setMcpServerEnabled: (
    id: string,
    enabled: boolean,
    query?: Partial<AgentCapabilityQuery>,
  ) => invoke(IPC.invoke.mcpSetEnabled, { id, enabled, ...query }),
  setMcpServerScope: (id: string, scope: ActivationScope) =>
    invoke(IPC.invoke.mcpSetScope, { id, scope }),
  /**
   * Move one server to the other level. The document is moved, not copied, and
   * the response carries the id it ended up under: a destination that already
   * holds the same id or name renames the arriving server.
   */
  transferMcpServer: (move: AgentCapabilityMove) =>
    invoke<{ server: McpServerRecord }>(IPC.invoke.mcpTransfer, move),
  /** Force one handshake and report what happened, for the editor's test button. */
  testMcpServer: (id: string, query?: Partial<AgentCapabilityQuery>) =>
    invoke<{ status: McpServerStatus }>(IPC.invoke.mcpTest, { id, ...query }),
  /** Launch browser-based OAuth 2.1 authorization flow for an HTTP MCP server. */
  startMcpOAuth: (id: string, query?: Partial<AgentCapabilityQuery>) =>
    invoke<{ ok: boolean; loginId: string }>(IPC.invoke.mcpOauthStart, { id, ...query }),
  cancelMcpOAuth: (payload: { loginId?: string; id?: string }) =>
    invoke<{ ok: boolean }>(IPC.invoke.mcpOauthCancel, payload),
  /** Accept a pasted `mcpServers` block; bad entries are reported, not fatal. */
  importMcpServers: (text: string) =>
    invoke<{
      imported: McpServerRecord[];
      failed: Array<{ id: string; reason: string }>;
    }>(IPC.invoke.mcpImport, { text }),
  /**
   * Scan third-party AI-tool config files for MCP server definitions. The
   * scanner never throws; a source that failed to read is reported with an
   * `error` on its row and a zero count.
   */
  scanExternalMcp: (query?: { projectPath?: string }) =>
    invoke<ExternalMcpScanResult>(IPC.invoke.mcpImportScan, query ?? {}),
  /**
   * Import each candidate through `mcp.upsert` one at a time; a `disabled`
   * item is turned off with `mcp.setEnabled` after it is written. One failure
   * never aborts the batch.
   */
  runExternalMcpImport: (payload: ExternalMcpImportPayload) =>
    invoke<ExternalMcpImportRunResult>(IPC.invoke.mcpImportRun, payload),
  /** Query the configured market sources; `failedSources` names dead ones. */
  searchMcpMarketRegistry: (query: string, sources: MarketSource[], options?: { more?: boolean }) =>
    invoke<{ entries: McpCatalogEntry[]; failedSources?: string[]; exhausted?: boolean }>(
      IPC.invoke.mcpMarketSearch,
      { query, sources, ...options },
    ),

  // --- Skill market ----------------------------------------------------------
  searchSkillMarket: (query: string, sources: { id: string; name: string; url: string }[]) =>
    invoke<{
      entries: SkillCatalogEntry[];
      failedSources?: string[];
      /**
       * Why each named source failed, so the market can explain a policy/DNS
       * refusal instead of reporting every source as merely unreachable.
       */
      failureKinds?: Record<string, "policy" | "fake-ip" | "unresolved" | "network">;
      /**
       * The host, the address it resolved to, and the guard's own reason behind
       * each failed source. Without them the panel can say a source was refused
       * but not *what* was refused — and `198.18.0.1` is what tells a user their
       * proxy is in fake-IP mode. `route` adds which route the guard judged that
       * address on, so a fake-IP refusal on a direct route reads apart from one
       * on a proxied route (issue #419, ADR 0272).
       */
      failureDetails?: Record<
        string,
        { host?: string; address?: string; reason?: string; addressKind?: string; route?: string }
      >;
    }>(IPC.invoke.skillMarketSearch, { query, sources }),
  /** Fetch one catalog document (frontmatter split off) for preview/install. */
  fetchSkillMarketDocument: (entry: SkillCatalogEntry) =>
    invoke<{ name?: string; description?: string; body: string; resources?: Array<{ path: string; body: string }> }>(
      IPC.invoke.skillMarketFetch,
      { entry },
    ),

  // --- Skills the user owns -------------------------------------------------
  listUserSkills: (query?: AgentCapabilityQuery) =>
    invoke<{ skills: UserSkillRecord[] }>(IPC.invoke.skillList, query),
  createUserSkill: (skill: UserSkillInput) =>
    invoke<{ skill: UserSkillRecord }>(IPC.invoke.skillCreate, skill),
  /**
   * Opens a native picker for one file or (when `sourceKind === "dir"`) a
   * folder; `canceled` when the user backed out. `mode: "link"` swaps copy
   * for a symlink import.
   */
  importUserSkill: (
    query?: AgentCapabilityQuery & {
      sourceKind?: "file" | "dir";
      mode?: "copy" | "link";
    },
  ) => invoke<{ canceled?: boolean; skill?: UserSkillRecord }>(IPC.invoke.skillImport, query),
  /**
   * Scan third-party AI-tool skill directories. The scanner never throws;
   * a source that failed to read is reported with an `error` on its row.
   */
  scanExternalSkills: (query?: { projectPath?: string }) =>
    invoke<ExternalSkillScanResult>(IPC.invoke.skillImportScan, query ?? {}),
  /**
   * Import each candidate through `skills.import` one at a time. `mode`
   * defaults to `"copy"`; a `dir` shape sends its `rootDir` as the source
   * path so host-core knows it is a `<name>/SKILL.md` skill.
   */
  runExternalSkillsImport: (payload: ExternalSkillImportPayload) =>
    invoke<ExternalSkillImportRunResult>(IPC.invoke.skillImportRun, payload),
  updateUserSkill: (id: string, skill: Omit<UserSkillInput, "id">) =>
    invoke<{ skill: UserSkillRecord }>(IPC.invoke.skillUpdate, { id, ...skill }),
  /** The record plus the document body, for the editor. */
  readUserSkill: (id: string, query?: Partial<AgentCapabilityQuery>) =>
    invoke<{ skill: UserSkillRecord | null; body?: string }>(IPC.invoke.skillRead, {
      id,
      ...query,
    }),
  removeUserSkill: (id: string, query?: Partial<AgentCapabilityQuery>) =>
    invoke(IPC.invoke.skillRemove, { id, ...query }),
  setUserSkillEnabled: (
    id: string,
    enabled: boolean,
    query?: Partial<AgentCapabilityQuery>,
  ) => invoke(IPC.invoke.skillSetEnabled, { id, enabled, ...query }),
  setUserSkillScope: (id: string, scope: ActivationScope) =>
    invoke(IPC.invoke.skillSetScope, { id, scope }),
  /**
   * Move one skill to the other level. The document is moved, not copied, and
   * the response carries the id it ended up under: a destination that already
   * holds the same id or display name renames the arriving skill.
   */
  transferUserSkill: (move: AgentCapabilityMove) =>
    invoke<{ skill: UserSkillRecord }>(IPC.invoke.skillTransfer, move),
  /**
   * Level and project must travel with the id: a project skill has no global
   * counterpart to fall back to, so resolving by id alone would miss it.
   */
  revealUserSkill: (id: string, query?: Partial<AgentCapabilityQuery>) =>
    invoke(IPC.invoke.skillReveal, { id, ...query }),

  // --- Subagents the user owns ----------------------------------------------
  listUserSubagents: (query?: Pick<AgentCapabilityQuery, "level">) =>
    invoke<{ subagents: UserSubagentRecord[] }>(IPC.invoke.subagentList, query),
  /**
   * What `Task` would offer right now, merged across the shipped builtins and
   * the registry. `builtins` keeps a switched-off default in the list, flagged
   * `enabled: false`, so Settings can still show that row and its switch.
   */
  subagentCatalog: () =>
    invoke<{
      subagents: SubagentDefinition[];
      builtins: Array<SubagentDefinition & { enabled: boolean }>;
      diagnostics: string[];
      projectPath: string | null;
    }>(IPC.invoke.subagentCatalog),
  createUserSubagent: (subagent: UserSubagentInput) =>
    invoke<{ subagent: UserSubagentRecord }>(IPC.invoke.subagentCreate, subagent),
  updateUserSubagent: (id: string, subagent: Omit<UserSubagentInput, "id">) =>
    invoke<{ subagent: UserSubagentRecord }>(IPC.invoke.subagentUpdate, {
      id,
      ...subagent,
    }),
  /** The record plus the document body, for the editor. */
  readUserSubagent: (id: string) =>
    invoke<{ subagent: UserSubagentRecord | null; body?: string }>(
      IPC.invoke.subagentRead,
      id,
    ),
  removeUserSubagent: (id: string) => invoke(IPC.invoke.subagentRemove, id),
  setUserSubagentEnabled: (id: string, enabled: boolean) =>
    invoke(IPC.invoke.subagentSetEnabled, { id, enabled }),
  /**
   * Turn one shipped default off, or back on. The id is the `Task` handle
   * (`explorer`), never a document id: a builtin has no file to switch.
   */
  setBuiltinSubagentEnabled: (id: string, enabled: boolean) =>
    invoke<{ id: string; enabled: boolean }>(IPC.invoke.subagentSetBuiltinEnabled, {
      id,
      enabled,
    }),
  setUserSubagentScope: (id: string, scope: ActivationScope) =>
    invoke(IPC.invoke.subagentSetScope, { id, scope }),
  /** Registry entries reveal by id; project documents pass their own path. */
  revealSubagent: (target: { id?: string; path?: string }) =>
    invoke(IPC.invoke.subagentReveal, target),
  openPluginPanel: (id: string) => invoke(IPC.invoke.pluginOpenPanel, id),
  togglePluginLauncher: () => invoke(IPC.invoke.pluginLauncherToggle),
  dismissPluginLauncher: () => invoke(IPC.invoke.pluginLauncherDismiss),
  listPluginThemes: () => invoke<PluginTheme[]>(IPC.invoke.pluginThemes),
  listPluginScenicThemesDestinations: () => invoke<PluginScenicThemesDestinationMeta[]>(IPC.invoke.pluginScenicThemesDestinations),
  setPluginScenicThemeBlur: (pluginId: string, themeId: string, blur: number) => invoke(IPC.invoke.pluginScenicThemesSetBlur, { pluginId, themeId, blur }),
  listPluginServices: () => invoke<PluginServiceStatus[]>(IPC.invoke.pluginServices),
  /**
   * Work panel views, already filtered by permission, activation scope, and
   * entry existence, with titles resolved for the active locale (ADR 0104).
   */
  listPluginViews: () => invoke<PluginViewMeta[]>(IPC.invoke.pluginViews),
  /** Create or reuse the view's web contents. Does not show it. */
  pluginViewOpen: (
    pluginId: string,
    viewId: string,
    extra?: { sessionId?: string; location?: string },
  ) => invoke(IPC.invoke.pluginViewOpen, { pluginId, viewId, ...extra }),
  pluginViewClose: (pluginId: string, viewId: string) =>
    invoke(IPC.invoke.pluginViewClose, { pluginId, viewId }),
  pluginViewSetBounds: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => invoke(IPC.invoke.pluginViewSetBounds, bounds),
  pluginViewSetVisible: (
    pluginId: string,
    viewId: string,
    visible: boolean,
    sessionId?: string,
  ) =>
    invoke(IPC.invoke.pluginViewSetVisible, {
      pluginId,
      viewId,
      visible,
      sessionId,
    }),
  marketRefresh: (force = true) =>
    invoke<{
      providerId: string;
      name?: string;
      homepage?: string;
      updatedAt?: string;
      pluginCount: number;
      sourceUrl: string;
    }>(IPC.invoke.marketRefresh, { force }),
  marketSearch: (query = "", category = "") =>
    invoke<{
      plugins: MarketPluginSummary[];
      providerId: string;
      sourceUrl: string;
    }>(IPC.invoke.marketSearch, { query, category }),
  marketGetDetail: (id: string) =>
    invoke<{ plugin: MarketPluginDetail }>(IPC.invoke.marketGetDetail, id),
  marketInstall: (input: {
    id: string;
    version?: string;
    enable?: boolean;
    autoUpdate?: boolean;
    grantedPermissions?: string[];
  }) =>
    invoke<{ result: PluginInstallResult }>(IPC.invoke.marketInstall, input),
  marketCheckUpdates: (refreshRemote = true) =>
    invoke<{ updates: unknown[]; plugins: PluginSummary[] }>(
      IPC.invoke.marketCheckUpdates,
      { refreshRemote },
    ),
  marketApplyUpdates: (onlyAuto = true) =>
    invoke<{ results: PluginInstallResult[]; plugins: PluginSummary[] }>(
      IPC.invoke.marketApplyUpdates,
      { onlyAuto },
    ),
  /** Ask the running install to stop. Only a download can be interrupted. */
  marketCancelInstall: (id: string) =>
    invoke<{ cancelled: boolean; id: string }>(IPC.invoke.marketCancelInstall, { id }),
  /** Import a pi CLI extension file or directory as a development plugin (spec 16 §3). */
  importPiExtension: () =>
    invoke<
      | { canceled: true }
      | {
          canceled: false;
          id: string;
          path: string;
          entries: string[];
          dependencies:
            | { state: "skipped"; reason: "no-package-json" | "no-dependencies" }
            | { state: "installed" }
            | { state: "failed"; error: string; reason?: "npm-unavailable" };
        }
    >(IPC.invoke.pluginImportExtension),
  runExtensionCommand: (input: { sessionId: string; name: string; args: string }) =>
    invoke<{ ok: boolean }>(IPC.invoke.extensionsCommandRun, input),
  respondExtensionPrompt: (response: TrustedExtensionUiPromptResponse) =>
    invoke<{ ok: boolean }>(IPC.invoke.extensionsUiRespond, response),
  searchCommands: (query: string) =>
    invoke<{ commands: CommandItem[] }>(
      IPC.invoke.commandPaletteSearch,
      query,
    ),
  executeCommand: (commandId: string) =>
    invoke(IPC.invoke.commandPaletteExecute, commandId),
  openLogs: () => invoke(IPC.invoke.logOpenFolder),
  /**
   * Quit the application. Used by the surfaces that own the window before the
   * shell has data; the main process runs the same ordered shutdown as the Quit
   * menu item, so the answer may never arrive — callers must not depend on it.
   */
  quitApp: () => invoke<{ ok: boolean }>(IPC.invoke.appQuit),
  /** Toggles the devtools console; rejects unless developer mode is on. */
  toggleDevTools: (open?: boolean) =>
    invoke<{ open: boolean }>(IPC.invoke.devtoolsToggle, { open }),
  workspaceDiff: () => invoke<WorkspaceDiff>(IPC.invoke.workspaceDiff),
  workspaceReviewRollback: (input: {
    sessionId: string;
    snapshotId: string;
  }) => invoke<ReviewRollbackResult>(IPC.invoke.workspaceReviewRollback, input),
  browserNavigate: (url: string, sessionId?: string) =>
    invoke<BrowserState>(IPC.invoke.browserNavigate, { url, sessionId }),
  browserAction: (action: BrowserAction) =>
    invoke(IPC.invoke.browserAction, { action }),
  browserSetBounds: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => invoke(IPC.invoke.browserSetBounds, bounds),
  browserSetVisible: (visible: boolean) =>
    invoke(IPC.invoke.browserSetVisible, { visible }),
  browserOpenExternal: (url?: string) =>
    invoke(IPC.invoke.browserOpenExternal, url ? { url } : {}),
  browserGetState: () =>
    invoke<BrowserState | null>(IPC.invoke.browserGetState),
  fsList: (path?: string) =>
    invoke<{ entries: FsEntry[] }>(IPC.invoke.fsList, { path: path ?? "" }),
  fsRead: (path: string, mimeType?: string) =>
    invoke<FsReadResult>(IPC.invoke.fsRead, {
      path,
      ...(mimeType ? { mimeType } : {}),
    }),
  fsReadImageDataUrl: (ref: string, mimeType?: string) =>
    invoke<FsImageDataUrlResult>(IPC.invoke.fsReadImageDataUrl, {
      ref,
      ...(mimeType ? { mimeType } : {}),
    }),
  fsReveal: (path: string) => invoke(IPC.invoke.fsReveal, { path }),
  fsOpen: (path: string) => invoke(IPC.invoke.fsOpen, { path }),
  fsIndex: () => invoke<FsIndexResult>(IPC.invoke.fsIndex),
  /**
   * Complete a file reference from chat text to a real file (D320 follow-up).
   * The main process owns the root order — project, session scratch,
   * attachments — because only it can see the scratch store.
   */
  fsResolveRef: (ref: string, sessionId?: string) =>
    invoke<FsChatRefResolveResult>(IPC.invoke.fsResolveRef, {
      ref,
      ...(sessionId ? { sessionId } : {}),
    }),
  composerCommands: () =>
    invoke<{ commands: ComposerCommand[] }>(IPC.invoke.composerCommands),
  setWorkPanelReservation: (width: number) =>
    invoke<{ requested: number; reserved: number }>(
      IPC.invoke.windowSetWorkPanelReservation,
      { width },
    ),
  setWorkPanelChatWidth: (width: number) =>
    invoke<{ requested: number; applied: number }>(
      IPC.invoke.windowSetWorkPanelChatWidth,
      { width },
    ),
  setWindowBackgroundColor: (theme: "light" | "dark", color?: string) =>
    invoke<{ applied: boolean; theme: "light" | "dark"; color?: string }>(
      IPC.invoke.windowSetBackgroundColor,
      { theme, color },
    ),
  windowControl: (action: WindowControlAction) =>
    invoke<{ maximized: boolean }>(IPC.invoke.windowControl, { action }),
  getCloseBehavior: () =>
    invoke<{ behavior: CloseBehavior; supported: boolean }>(
      IPC.invoke.closeBehaviorGet,
    ),
  setCloseBehavior: (behavior: CloseBehavior) =>
    invoke<{ behavior: CloseBehavior }>(IPC.invoke.closeBehaviorSet, {
      behavior,
    }),
  getTokenUsageHistory: (query?: { startDate?: number; endDate?: number; bucket?: "day" | "week" | "month" }) =>
    invoke<import("@pi-desktop/shared").TokenUsageHistoryResult>(
      IPC.invoke.statsGetTokenUsageHistory,
      query,
    ),
  menuRendererReady: () =>
    invoke<{ ready: boolean }>(IPC.invoke.menuRendererReady),
  setTraySessionPreferences: (preferences: TraySessionPreferences) =>
    invoke<{ ok: boolean }>(IPC.invoke.traySetSessionPreferences, preferences),
  onTraySessionActivated: (listener: (sessionId: string | null) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.traySessionActivated, (payload) => {
      const sessionId = (payload as { sessionId?: unknown })?.sessionId;
      if (sessionId === null || (typeof sessionId === "string" && sessionId)) listener(sessionId);
    });
  },
  nativeMenuAction: (action: NativeMenuAction) =>
    invoke<{ maximized: boolean; fullScreen: boolean }>(
      IPC.invoke.nativeMenuAction,
      { action },
    ),
  onWindowMaximized: (listener: (event: { maximized: boolean }) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.windowMaximized, (payload) =>
      listener(payload as { maximized: boolean }),
    );
  },
  onWindowFullScreen: (listener: (event: { fullScreen: boolean }) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.windowFullScreen, (payload) =>
      listener(payload as { fullScreen: boolean }),
    );
  },
  onWorkPanelResize: (
    listener: (event: {
      phase: "preview" | "commit";
      panelWidth: number;
    }) => void,
  ) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.windowWorkPanelResize, (payload) =>
      listener(
        payload as {
          phase: "preview" | "commit";
          panelWidth: number;
        },
      ),
    );
  },
  onMenuCommand: (listener: (command: AppMenuCommand) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.menuCommand, (payload) =>
      listener((payload as { command: AppMenuCommand }).command),
    );
  },
  onBrowserState: (listener: (state: BrowserState) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.browserState, (payload) =>
      listener(payload as BrowserState),
    );
  },
  onBrowserPreview: (
    listener: (event: { sessionId: string; path?: string; url?: string }) => void,
  ) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.browserPreview, (payload) =>
      listener(payload as { sessionId: string; path?: string; url?: string }),
    );
  },
  onAgentEvent: (listener: (event: AgentEventEnvelope) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.agentMessage, (payload) =>
      listener(payload as AgentEventEnvelope),
    );
  },
  onAgentQueueChanged: (listener: (event: AgentQueueChangedEvent) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.agentQueueChanged, (payload) =>
      listener(payload as AgentQueueChangedEvent),
    );
  },
  onPlansChanged: (listener: (event: PlanningStateEvent) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.plansChanged, (payload) =>
      listener(normalizePlansChangedEvent(payload)),
    );
  },
  onOauthLogin: (listener: (event: OAuthLoginEvent) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.providersOauth, (payload) =>
      listener(payload as OAuthLoginEvent),
    );
  },
  onMcpOAuth: (listener: (event: McpOAuthLoginEvent) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.mcpOauth, (payload) =>
      listener(payload as McpOAuthLoginEvent),
    );
  },
  onExtensionPrompt: (listener: (prompt: TrustedExtensionUiPrompt) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.extensionsUiPrompt, (payload) =>
      listener(payload as TrustedExtensionUiPrompt),
    );
  },
  onExtensionStatus: (listener: (event: TrustedExtensionStatusEvent) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.extensionsStatus, (payload) =>
      listener(payload as TrustedExtensionStatusEvent),
    );
  },
  onToast: (listener: (message: string) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.toast, (payload) =>
      listener((payload as { message: string }).message),
    );
  },
  onInsecureEndpointNotice: (listener: (payload: { host: string }) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.insecureEndpointNotice, (payload) =>
      listener(payload as { host: string }),
    );
  },
  onHostStatus: (listener: (status: HostStatusEvent) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.hostStatus, (payload) =>
      listener(payload as HostStatusEvent),
    );
  },
  onNotificationChanged: (
    listener: (notification: AppNotification) => void,
  ) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.notificationChanged, (payload) =>
      listener((payload as { notification: AppNotification }).notification),
    );
  },

  // --- Remote hosts (R2b pairing UX) -----------------------------------------
  /** Paired remote `pi-host` list, redacted so no device token reaches here. */
  listRemoteHosts: () =>
    invoke<{ hosts: RemoteHostSummary[] }>(IPC.invoke.remoteHostList),
  /** Exchange `ppt1.` pairing token for a durable device token and connect. */
  pairRemoteHost: (request: RemoteHostPairRequest) =>
    invoke<RemoteHostPairResult>(IPC.invoke.remoteHostPair, request),
  /**
   * Install and pair a `pi-host` over SSH on a machine the user already
   * reaches, then bring it online (spec §5.2). Credentials come from the
   * user's own SSH configuration and agent.
   */
  bootstrapRemoteHost: (request: RemoteHostBootstrapRequest) =>
    invoke<RemoteHostBootstrapResult>(IPC.invoke.remoteHostBootstrap, request),
  /** Close and drop a paired host by its stable routing key. */
  removeRemoteHost: (hostKey: string) =>
    invoke<{ ok: true }>(IPC.invoke.remoteHostRemove, { hostKey }),
  onSessionsChanged: (
    listener: (event: {
      reason?: string;
      pluginId?: string;
      projectPath?: string | null;
      selectSessionId?: string;
    }) => void,
  ) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.sessionsChanged, (payload) =>
      listener(
        (payload ?? {}) as {
          reason?: string;
          pluginId?: string;
          projectPath?: string | null;
          selectSessionId?: string;
        },
      ),
    );
  },
  onNotificationActivated: (
    listener: (event: { id: string; sessionId: string }) => void,
  ) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.notificationActivated, (payload) =>
      listener(payload as { id: string; sessionId: string }),
    );
  },
  onUpdateState: (listener: (state: UpdateState) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.updatesState, (payload) =>
      listener(payload as UpdateState),
    );
  },
  onPluginInstallProgress: (listener: (event: PluginInstallProgress) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.pluginInstallProgress, (payload) =>
      listener(payload as PluginInstallProgress),
    );
  },

  onPluginChanged: (
    listener: (event: { reason?: string; pluginId?: string }) => void,
  ) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.pluginChanged, (payload) =>
      listener((payload ?? {}) as { reason?: string; pluginId?: string }),
    );
  },
  onSettingsChanged: (listener: (patch: Record<string, unknown>) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.settingsChanged, (payload) =>
      listener((payload ?? {}) as Record<string, unknown>),
    );
  },
  onConfigSyncChanged: (listener: (state: ConfigSyncState) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.configSyncChanged, (payload) =>
      listener(payload as ConfigSyncState),
    );
  },
  onConfigSyncProgress: (listener: (progress: ConfigSyncProgress) => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.configSyncProgress, (payload) =>
      listener(payload as ConfigSyncProgress),
    );
  },
  onPluginLauncherShown: (listener: () => void) => {
    if (!window.piDesktop?.on) return () => undefined;
    return window.piDesktop.on(IPC.event.pluginLauncherShown, () => listener());
  },
};
