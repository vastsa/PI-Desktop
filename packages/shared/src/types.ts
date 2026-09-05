import type { ActivationScope } from "./activation.js";
import type { AppError } from "./errors.js";
import type { KeybindingOverrides } from "./keyboard-shortcuts.js";
import type { CommandShellId } from "./command-shells.js";

export type Mode = "plan" | "goal" | "agent";

/** Normalize mode values at compatibility boundaries. Older persisted and
 * scheduled data used `chat`; it is now the Plan operating state. */
export function normalizeMode(value: unknown, fallback: Mode = "agent"): Mode {
  if (value === "agent") return "agent";
  if (value === "goal") return "goal";
  if (value === "plan" || value === "chat") return "plan";
  return fallback;
}

/** Approval-proposal discriminator (D198). Plan and Goal share one host
 * approval pipeline; `kind` selects prompts, artifact directory and copy. */
export type ProposalKind = "plan" | "goal";

export const PROPOSAL_KINDS = ["plan", "goal"] as const;

export function normalizeProposalKind(
  value: unknown,
  fallback: ProposalKind = "plan",
): ProposalKind {
  return value === "goal" || value === "plan" ? value : fallback;
}

/** The proposal kind a mode submits, or `null` for freely executing modes. */
export function proposalKindForMode(mode: Mode): ProposalKind | null {
  return mode === "plan" || mode === "goal" ? mode : null;
}

/** The operating mode that owns a proposal kind. */
export function modeForProposalKind(kind: ProposalKind): Mode {
  return kind;
}

export type PlanningState = "inactive" | "planning" | "awaiting_approval";
export type PlanApprovalAction = "approve" | "reject";
export type PlanApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "interrupted";

/** Compatibility name for the proposal-shaped approval wire record. */
export type PlanProposalStatus = PlanApprovalStatus;

export type PlanArtifact = {
  /** Workspace-relative path of the host-created plan artifact. */
  relativePath: string;
  sha256: string;
  sizeBytes: number;
};

export type PlanExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "interrupted";

export type PlanExecutionFinishStatus = Extract<
  PlanExecutionState,
  "completed" | "interrupted"
>;

export type PlanProposal = {
  /** Durable approval/proposal identity. */
  id: string;
  sessionId: string;
  /** Durable host turn ID owning the SubmitPlan/SubmitGoal call. */
  turnId: string;
  /** Exact SubmitPlan/SubmitGoal tool-call ID used to create this approval. */
  toolCallId: string;
  /** Which contract this approval carries; legacy rows read back as `plan`. */
  kind: ProposalKind;
  title: string;
  /** Exact Markdown snapshot submitted for approval. */
  markdown: string;
  question: string;
  artifact?: PlanArtifact;
  /** Host schema/version for this proposal snapshot. */
  version: number;
  status: PlanProposalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  errorCode?: string;
  executionId?: string;
  executionState?: PlanExecutionState;
  /** Persisted snapshot alias retained by the host for compatibility. */
  plan: string;
};

/** Descriptor persisted by the host after approval and consumed by Main. */
export type PlanExecution = {
  id: string;
  proposalId: string;
  sessionId: string;
  /** Which contract was approved; drives the execution instruction. */
  kind: ProposalKind;
  /** Exact approved Markdown snapshot. */
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

export type PlanExecutionDescriptor = PlanExecution;
export type ApprovedPlanExecution = PlanExecution;

export type PlanningStateEvent = {
  sessionId: string;
  state: PlanningState;
  /** Absent only for `inactive` transitions that carry no proposal. */
  kind?: ProposalKind;
  proposalId?: string;
  title?: string;
  markdown?: string;
  question?: string;
  artifact?: PlanArtifact;
  version?: number;
  plan?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  executionId?: string;
  executionState?: PlanExecutionState;
  proposal?: PlanProposal;
};

export type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  /** Contract kind the session is currently negotiating, when any (D198). */
  kind?: ProposalKind;
};

export type PlansQueuedExecutionsResult = {
  executions: PlanExecution[];
};

type PlanResolveIdentity = {
  proposalId: string;
  /** Identity fields must match the live host approval row exactly. */
  sessionId: string;
  turnId: string;
  toolCallId: string;
  version?: number;
};

export type PlanResolveRequest =
  | (PlanResolveIdentity & {
      action: "approve";
      targetPermissionMode: GlobalPermissionMode;
    })
  | (PlanResolveIdentity & {
      action: "reject";
      targetPermissionMode?: never;
    });

export type PlanResolutionResult = {
  ok: boolean;
  proposal: PlanProposal;
  state: PlanningState;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  execution?: PlanExecution;
};
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelProviderMetadata = string | Record<string, unknown>;
export type ModelExperimentalMetadata = boolean | Record<string, unknown>;

const MODEL_VENDOR_PREFIXES = new Set([
  "anthropic",
  "amazon",
  "aws",
  "cohere",
  "deepseek",
  "deepseek-ai",
  "gemini",
  "google",
  "meta",
  "minimax",
  "mistral",
  "moonshot",
  "moonshotai",
  "openai",
  "qwen",
  "z-ai",
  "zai",
  "zhipuai",
  "x-ai",
  "xai",
]);

/** Match a configured model ID with a namespaced models.dev ID. */
export function modelIdsMatch(candidate: string, requested: string): boolean {
  const left = candidate.trim().toLowerCase();
  const right = requested.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) return true;
  // Some providers use `model@region` aliases; the base model remains the
  // same published record for matching purposes.
  if (left.startsWith(`${right}@`) || right.startsWith(`${left}@`)) return true;
  for (const separator of ["-", "."] as const) {
    const leftPrefix = left.split(`${separator}${right}`, 1)[0];
    if (
      left.startsWith(`${leftPrefix}${separator}${right}`) &&
      MODEL_VENDOR_PREFIXES.has(leftPrefix)
    ) {
      return true;
    }
    const rightPrefix = right.split(`${separator}${left}`, 1)[0];
    if (
      right.startsWith(`${rightPrefix}${separator}${left}`) &&
      MODEL_VENDOR_PREFIXES.has(rightPrefix)
    ) {
      return true;
    }
  }
  return false;
}

/** Provider-local model settings persisted with the provider configuration. */
export type ModelBinding = {
  id: string;
  contextWindow: number;
  maxTokens: number;
  /** Explicit endpoint levels; an empty or off-only set disables thinking. */
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
  /**
   * User override for image input. `null` or absent follows the published
   * models.dev capability; `true` forces image transport on for an endpoint the
   * catalog describes too narrowly, `false` keeps images out of the request.
   */
  supportsImages?: boolean | null;
  /**
   * User override for document (PDF) input, with the same three-state meaning.
   * Documents are still transported as bounded file references, so this records
   * the capability the model actually has rather than switching the encoding.
   */
  supportsDocuments?: boolean | null;
  /**
   * Whether this model is available for AI-driven subagent delegation.
   * When true, the model appears in the delegation model catalog so the
   * parent agent can pick it at Task time. Defaults to false (opt-in).
   */
  availableForSubagents?: boolean;
};

export type Risk = "low" | "medium" | "high";
export type PermissionDecision = "allow-once" | "allow-session" | "deny";
/** Permission mode (D115): how high-risk tool calls are approved.
 * `inherit` (sessions only) falls back to the global default. */
export const PERMISSION_MODES = ["inherit", "ask", "accept-edits", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Global default: `inherit` is not meaningful at the settings level. */
export type GlobalPermissionMode = Exclude<PermissionMode, "inherit">;

export function isGlobalPermissionMode(
  value: unknown,
): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

export function normalizeGlobalPermissionMode(
  value: unknown,
  fallback: GlobalPermissionMode = "ask",
): GlobalPermissionMode {
  return isGlobalPermissionMode(value) ? value : fallback;
}

export type UiMessageRole = "user" | "assistant" | "system" | "tool";

export type MessageUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
};

export type MessageAttachment = {
  kind: "image" | "file";
  name: string;
  /** Workspace-relative path or session-scratch absolute path. */
  ref: string;
  mimeType?: string;
  size?: number;
  /** Sidecar-only hydrated image data; never persisted or sent by the host. */
  data?: string;
};

/** Estimated context footprint for one tool call and its returned result. */
export type ToolTokenUsage = {
  argumentTokens: number;
  resultTokens: number;
  totalTokens: number;
  estimated: true;
};

export type UiMessage = {
  id: string;
  role: UiMessageRole;
  content: string;
  /** Files or images associated with a user turn, kept separate from text. */
  attachments?: MessageAttachment[];
  /** Model reasoning kept separate from the answer text. */
  thinking?: string;
  createdAt: string;
  status?: "streaming" | "complete" | "error" | "aborted";
  /** Provider/model that produced this assistant turn, when known. */
  modelId?: string;
  providerId?: string;
  /** Token usage for the assistant turn, when the provider reported it. */
  usage?: MessageUsage;
  /** Elapsed model streaming time used to calculate output throughput. */
  responseDurationMs?: number;
  /** Output tokens used only for throughput when a stopped stream has no final usage. */
  responseOutputTokens?: number;
  /** Structured failure attached to the assistant turn that failed. */
  error?: AppError;
  /** Stable regenerate-family key shared across rewritten user prompts. */
  revisionRootId?: string;
  /** Total regenerate variants for this user root turn. */
  revisionCount?: number;
  /** 1-based active variant index for this user root turn. */
  activeRevision?: number;
  /**
   * Typed slash invocation ("/name args") when this user message was
   * produced by a prompt-template command; `content` holds the expanded
   * text the model sees (D123). Transcript renders this as a chip.
   */
  command?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: "running" | "success" | "error" | "denied";
  toolArgs?: unknown;
  toolResult?: unknown;
  /** Estimated tokens occupied by this tool call and its result. */
  toolUsage?: ToolTokenUsage;
  toolCompletedAt?: string;
  toolDurationMs?: number;
  isError?: boolean;
  /**
   * Set on rows produced inside a subagent: the `Task` tool call that spawned
   * the delegate. Two consequences (ADR 0062): the transcript nests these rows
   * under that call, and the parent model never sees them — only the `Task`
   * report enters its context.
   */
  parentToolCallId?: string;
  /** Definition name of the subagent that produced this row. */
  agentName?: string;
};

/** Terminal outcome of one background subagent run. TaskStop adds its own
 * `stopped` projection at the delegation registry layer. */
export type SubagentRunStatus =
  | "completed"
  | "truncated"
  | "failed"
  | "aborted"
  | "timed_out";

/** Maximum number of Unicode code points accepted for a user-defined title. */
export const MAX_SESSION_TITLE_LENGTH = 80;

export type SessionSummary = {
  id: string;
  title: string;
  /** Number of messages in the current canonical transcript. */
  messageCount: number;
  projectPath?: string;
  modelId?: string;
  providerId?: string;
  mode: Mode;
  thinkingLevel: ThinkingLevel;
  /** Per-session permission mode; `inherit` follows the global default (D115). */
  permissionMode: PermissionMode;
  /** Effective capability for this session's exact provider/model pair. */
  supportsReasoning?: boolean;
  /** Effective image-input capability for this session's exact model. */
  supportsVision?: boolean;
  supportedThinkingLevels?: ThinkingLevel[];
  updatedAt: string;
  createdAt: string;
};

export type SessionDetail = SessionSummary & {
  messages: UiMessage[];
  /** Zero-based offset of the first message returned by a bounded history read. */
  messageStart?: number;
  /** True when older messages must be requested with another bounded read. */
  hasMoreBefore?: boolean;
  /** The checkpoint that governs the next model request, i.e. the last of
   * `compactions`. Restored by the runtime on load. */
  compaction?: ContextCompactionRecord;
  /** Every durable checkpoint, oldest first: the transcript shows one row per
   * compaction, the way Codex emits one `ContextCompaction` turn item each. */
  compactions?: ContextCompactionRecord[];
};

/**
 * @deprecated Not surfaced in settings and not persisted through to the
 * runtime. Retained as the runtime's construction-time override, which the
 * tests use to build a compaction-disabled session.
 */
export type ContextCompactionSettings = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

export type ContextCompactionRecord = {
  id: string;
  summary: string;
  firstKeptMessageId?: string;
  throughMessageId: string;
  tokensBefore: number;
  usage?: unknown;
  retainedTail?: unknown[];
  details?: unknown;
  providerId?: string;
  modelId?: string;
  createdAt: string;
};

/** What the context inspector shows about the installed checkpoint. */
export type ContextCompactionStatus = {
  /** How many checkpoints this session has installed, oldest counted as 1. */
  generation: number;
  /** Estimated tokens the summary itself occupies in the model context. */
  summaryTokens: number;
};

/**
 * One compaction, as the transcript renders it — Codex emits a
 * `ContextCompaction` turn item per compaction and this is its equivalent.
 *
 * Both the durable record and the live `compaction_end` event carry a mark
 * rather than the record itself: a record holds the whole summary and retained
 * tail, which is far too much payload for a stream event.
 */
export type ContextCompactionMark = ContextCompactionStatus & {
  id: string;
  /** Last message the checkpoint covers; the row renders right after it. */
  throughMessageId: string;
  /** False when the window rolled over without asking for a summary. */
  summarized: boolean;
};

export type ContextCompactionReason = "manual" | "threshold" | "overflow";
export type ContextCompactionFallback = "retained_tail";

export type MessageRevisionSummary = {
  revisionIndex: number;
  isActive: boolean;
  createdAt: string;
  messageCount: number;
};

export type AgentStatus = {
  sessionId: string;
  isRunning: boolean;
  currentTurnId?: string;
  modelId?: string;
  pendingToolConfirmations: number;
  planningState?: PlanningState;
  pendingPlanId?: string;
};

export type AgentPromptRequest = {
  sessionId: string;
  content: string;
  /** Attachments are resolved by Electron main and never trusted by the sidecar. */
  attachments?: AgentPromptAttachment[];
  /**
   * When set, truncate the durable transcript to this many leading messages
   * before appending the new user turn. Used by regenerate / edit-resend so
   * the branch replaces the tail instead of stacking a duplicate turn.
   *
   * Prefer `truncateFromMessageId`: a count is only correct when the renderer
   * holds the entire history, and it is kept for older callers.
   */
  truncateBefore?: number;
  /**
   * Identity of the first message to drop. The host resolves it against its own
   * transcript, so a bounded window or a deduplicated renderer array cannot
   * shift the cut. Takes precedence over `truncateBefore`.
   */
  truncateFromMessageId?: string;
  /**
   * Renderer-chosen id for the new user message (D288). The renderer inserts
   * the row under this id before the host round trip, and the host persists
   * and echoes the durable row under the same id so the echo replaces the
   * optimistic row in place instead of adding a second one. Must be a UUID
   * that is not already in the session; anything else is ignored and the host
   * mints its own.
   */
  messageId?: string;
  /**
   * Renderer snapshot of the chat session visible when the prompt was sent.
   * Electron installs it before asynchronous turn setup for notification
   * suppression; missing, null, or mismatched values fail safe.
   */
  viewingSessionId?: string | null;
};

export type AgentPromptAttachment = {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  size?: number;
};

export type AgentPromptResponse = {
  accepted: boolean;
  turnId: string;
};

/** One-shot Composer draft enhancement; this never reads session history. */
export type PromptEnhancementRequest = {
  sessionId?: string | null;
  draft: string;
  /** Renderer snapshot of the model currently shown in the Composer. */
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

export type PromptEnhancementResponse = {
  enhancedDraft: string;
};

export type AgentExecuteApprovedPlanRequest = {
  sessionId: string;
  turnId: string;
  execution: PlanExecution;
};

export type AgentExecuteApprovedPlanResponse = {
  accepted: boolean;
  turnId: string;
};

export type AgentAbortRequest = {
  sessionId: string;
  turnId?: string;
};

/** Request a stop at the next completed agent turn boundary. */
export type AgentStopRequest = {
  sessionId: string;
  turnId?: string;
};

export type AgentStopResponse = {
  requested: boolean;
};

export type AgentCompactRequest = {
  sessionId: string;
};

export type AgentCompactResponse = {
  accepted: boolean;
};

export type ToolPermissionRequest = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsPreview: unknown;
  risk: Risk;
  reason: string;
  /** Subagent that asked, when the call came from a delegate (ADR 0062). */
  agentName?: string;
  /** `Task` call that spawned the asking delegate. */
  parentToolCallId?: string;
};

export type ToolPermissionResolution = {
  requestId: string;
  decision: PermissionDecision;
};

/** A model-created question shown in the inline asktool card. */
export type AskToolQuestion = {
  question: string;
  options: string[];
  multiSelect?: boolean;
};

export type AskToolRequest = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  questions: AskToolQuestion[];
};

/** `null` means the user skipped that question or declined the whole prompt. */
export type AskToolResolution = {
  requestId: string;
  sessionId: string;
  answers: Array<string[] | null>;
};

/** Stable model-facing serialization for one asktool result. */
export function formatAskToolOutput(
  questions: AskToolQuestion[],
  answers: Array<string[] | null>,
): string {
  return questions
    .map((question, index) => {
      const answer = answers[index]?.join("、") ?? "";
      return `${question.question}：${answer}`;
    })
    .join("\n---\n");
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messageIds: string[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: UiMessage }
  | {
      type: "message_update";
      message: UiMessage;
      deltaText?: string;
      deltaThinking?: string;
    }
  | { type: "message_end"; message: UiMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; partialResult?: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      result: unknown;
      isError?: boolean;
      toolUsage?: ToolTokenUsage;
    }
  | ({ type: "planning_state" } & Omit<PlanningStateEvent, "sessionId">)
  | { type: "tool_permission_request"; request: ToolPermissionRequest }
  | { type: "asktool_request"; request: AskToolRequest }
  | {
      type: "compaction_start";
      reason: ContextCompactionReason;
    }
  | {
      type: "compaction_end";
      reason: ContextCompactionReason;
      ok: boolean;
      tokensBefore?: number;
      firstKeptMessageId?: string;
      willRetry: boolean;
      fallback?: ContextCompactionFallback;
      /** Present when a checkpoint was installed: it feeds the transcript row
       * and the context inspector. */
      mark?: ContextCompactionMark;
      error?: { code: string; message: string };
    }
  | { type: "error"; error: AppError }
  | { type: "status"; status: AgentStatus };

export type AgentEventEnvelope = {
  sessionId: string;
  turnId?: string;
  ts: number;
  event: AgentEvent;
  /**
   * Set on every event emitted from inside a subagent (ADR 0062): the `Task`
   * tool call that owns the delegate. Main tags persisted rows with it and
   * skips the turn-lifecycle handling that belongs to the parent alone.
   */
  parentToolCallId?: string;
  /** Definition name of the emitting subagent. */
  agentName?: string;
};

export type AppNotificationKind = "task.completed" | "task.failed";

export type AppNotification = {
  id: string;
  kind: AppNotificationKind;
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string | null;
};

export type NotificationListResult = {
  notifications: AppNotification[];
  unreadCount: number;
};

export type ProjectWorkspace = {
  path: string;
  name: string;
  /** Best-effort git branch from .git/HEAD when available. */
  branch?: string;
};

export type ProjectRecord = {
  id: number;
  path: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  lastOpenedAt: number;
};

export type PullRequestSummary = {
  number: number;
  title: string;
  url: string;
  author?: string;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  isDraft?: boolean;
};

/**
 * `authKind` for a provider row whose credential is a vendor-account OAuth
 * login rather than a pasted API key. Shared so main, the sidecar runtime and
 * the renderer all branch on the same spelling.
 */
export const OAUTH_AUTH_KIND = "oauth";

export type ProviderPublic = {
  id: string;
  name: string;
  vendorKey: string;
  type: "native" | "openai_compatible" | "custom";
  protocol: string;
  enabled: boolean;
  baseUrl?: string;
  authKind: string;
  /** True when the provider holds an API key **or** a vendor-account login. */
  hasSecret: boolean;
  /** True when a vendor-account OAuth credential is stored. */
  hasOauth?: boolean;
  /** Non-secret label for the signed-in account; never carries a token. */
  oauthAccountLabel?: string;
  /** Per-model settings selected in the provider dialog. */
  models: ModelBinding[];
  /** @deprecated Use `models[0]?.id`; retained for older runtime consumers. */
  defaultModelId?: string;
  apiStyle?: string;
  /** Effective capability for the provider's current default model. */
  supportsReasoning: boolean;
  /** Effective image-input capability for the provider's current default model. */
  supportsVision?: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  /** Model context window override in tokens (runtime default when absent). */
  contextWindow?: number;
  /** Max output tokens override (runtime default when absent). */
  maxOutputTokens?: number;
  /** Sampling temperature override (provider default when absent). */
  temperature?: number;
  createdAt: string;
  updatedAt: string;
};

export type ProviderCreateInput = {
  name: string;
  vendorKey?: string;
  type?: "native" | "openai_compatible" | "custom";
  protocol?: string;
  baseUrl?: string;
  authKind?: string;
  models?: ModelBinding[];
  /** @deprecated Use `models[0]?.id`; retained for older callers. */
  defaultModelId?: string;
  secretValue?: string;
  apiStyle?: string;
  /**
   * Non-secret label for the signed-in vendor account. Account removal deletes
   * the owning provider row instead of clearing only this label.
   */
  oauthAccountLabel?: string;
  /** Explicit override for custom model catalogs. */
  supportsReasoning?: boolean;
  /**
   * Optional sparse override for custom/compatible models.
   * Values are canonical ThinkingLevel entries such as ["off","high"].
   * When omitted, capability resolution falls back to catalog/default sets.
   */
  supportedThinkingLevels?: ThinkingLevel[];
  /** Context window override in tokens; on update, 0 clears the override. */
  contextWindow?: number;
  /** Max output tokens override; on update, 0 clears the override. */
  maxOutputTokens?: number;
  /** Sampling temperature override; on update, 0 clears the override. */
  temperature?: number;
};

export type ProviderUpdateInput = Partial<ProviderCreateInput> & {
  id: string;
  enabled?: boolean;
};

/** One locally configured account for a vendor OAuth provider. */
export type OAuthAccount = {
  /** Provider row that owns this account's encrypted OAuth grant. */
  providerId: string;
  /** Non-secret account label, when the vendor exposes one. */
  accountLabel?: string;
  /** False for an orphaned row whose credential has already been removed. */
  connected: boolean;
};

/**
 * A vendor whose subscription account can be signed into instead of pasting an
 * API key. Derived from the runtime's built-in provider catalog, never a
 * hardcoded list. A vendor can own multiple independent local accounts.
 */
export type OAuthVendor = {
  /** Vendor id in the model runtime, e.g. "anthropic", "github-copilot". */
  vendorId: string;
  name: string;
  /** Vendor-supplied call to action, e.g. "Sign in with Claude Pro/Max". */
  loginLabel?: string;
  /** Whether access is backed by a paid subscription rather than usage credit. */
  isSubscription: boolean;
  /** Every local provider row created for this vendor. */
  accounts: OAuthAccount[];
};

export type OAuthPromptOption = {
  id: string;
  label: string;
  description?: string;
};

/** One question the vendor's login flow needs answered before it can finish. */
export type OAuthPromptRequest = {
  promptId: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: OAuthPromptOption[];
};

/**
 * Progress of one login attempt, pushed to the renderer. Carries nothing
 * secret: tokens stay in the main process.
 */
export type OAuthLoginEvent = {
  loginId: string;
  vendorId: string;
} & (
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | {
      kind: "authUrl";
      url: string;
      instructions?: string;
      /** False when the browser could not be launched and the user must copy the link. */
      opened: boolean;
    }
  | {
      kind: "deviceCode";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { kind: "progress"; message: string }
  | { kind: "prompt"; request: OAuthPromptRequest }
  /** The flow resolved a prompt on its own — e.g. the callback beat the paste box. */
  | { kind: "promptCancelled"; promptId: string }
  | { kind: "done"; providerId: string; accountLabel?: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }
);

export type OAuthStartResult = {
  loginId: string;
};

export type OAuthRespondInput = {
  loginId: string;
  promptId: string;
  /** Absent cancels the prompt, which aborts the login flow. */
  value?: string;
};

export const MODEL_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

export type ModelReasoningOption = {
  type: string;
  values?: Array<string | null>;
  min?: number;
  max?: number;
};

export type ModelInterleaved = boolean | { field?: string };

export type ModelModalities = {
  input: readonly ModelModality[];
  output: readonly ModelModality[];
};

export type ModelLimit = {
  context?: number;
  input?: number;
  output?: number;
};

export type ModelCostTier = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tier?: { type?: string; size?: number };
};

export type ModelCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  inputAudio?: number;
  outputAudio?: number;
  contextOver200k?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  tiers?: ModelCostTier[];
};

export type ModelInfo = {
  modelId: string;
  displayName: string;
  providerId: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoningOptions?: ModelReasoningOption[];
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  knowledge?: string;
  releaseDate?: string;
  lastUpdated?: string;
  modalities?: ModelModalities;
  openWeights?: boolean;
  limit?: ModelLimit;
  cost?: ModelCost;
  interleaved?: ModelInterleaved;
  status?: string;
  /** Provider-local upstream metadata, including models.dev adapter details. */
  provider?: ModelProviderMetadata;
  /** Model metadata extension published by models.dev. */
  experimental?: ModelExperimentalMetadata;
  /** Convenience values retained for existing UI and cache consumers. */
  contextWindow?: number;
  maxTokens?: number;
  capabilities: Array<
    | "text"
    | "tools"
    | "vision"
    | "reasoning"
    | "json"
    | "audio"
    | "video"
    | "pdf"
    | "attachments"
    | "temperature"
  >;
  supportedThinkingLevels?: ThinkingLevel[];
  source: "bundled" | "discovered" | "user";
  /** Metadata catalog that supplied this row, when it is a known model. */
  catalogSource?: "models.dev";
};

/**
 * Built-in themes, or `plugin:<pluginId>:<themeId>` for a theme contributed by
 * a plugin. The shell falls back to `system` when the provider goes away.
 */
export type ThemePreference = "system" | "light" | "dark" | `plugin:${string}`;

/**
 * What closing the main window does on Windows/Linux. macOS keeps the native
 * Dock lifecycle and never consults this preference.
 * - `ask`: transient unset state — the first close prompts once; after a
 *   choice is made it is remembered permanently and cannot be reverted
 * - `tray`: hide to the system tray; the app keeps running in the background
 * - `quit`: close the window and exit the app (legacy behavior)
 */
export type CloseBehavior = "ask" | "tray" | "quit";

export type AppSettings = {
  defaultProviderId?: string;
  defaultModelId?: string;
  defaultMode: Mode;
  /** Configured command shell for the agent Bash protocol tool. */
  defaultCommandShell?: CommandShellId;
  /** Global permission mode default; sessions with `inherit` follow this. */
  defaultPermissionMode?: GlobalPermissionMode;
  theme: ThemePreference;
  /** UI language; `auto` (and absent) follows the OS locale. */
  language?: "auto" | "en" | "zh-CN";
  /**
   * Global UI font stack (CSS `font-family` value). Absent means the built-in
   * token stack; bundled open-source families and installed system families
   * are offered by the settings picker.
   */
  fontFamily?: string;
  enterToSend: boolean;
  /** Text length above which a plain-text paste becomes a session file reference. */
  largePasteThreshold?: number;
  /**
   * @deprecated No longer read. Compaction derives its budgets from the model
   * window instead of exposing knobs; persisted values are ignored so a
   * session disabled long ago is not stuck without a switch to re-enable it.
   */
  contextCompaction?: ContextCompactionSettings;
  /** User overrides for the shared application shortcut map. */
  keybindings?: KeybindingOverrides;
  /** Unlocks the devtools console (settings button, F12, macOS View menu). */
  developerMode?: boolean;
  /**
   * Extension marketplace provider. `mirror` targets the cnb.cool copy for
   * networks that cannot reach `raw.githubusercontent.com`; both serve the
   * same catalog and packages.
   */
  pluginMarketSource?: PluginMarketSource;
  /** Catalog URL used when `pluginMarketSource` is `custom`. */
  pluginMarketCustomUrl?: string;
  onboardingDismissed: boolean;
};

export type PluginMarketSource = "official" | "mirror" | "custom";

export type PluginUpdateInfo = {
  version: string;
  changelog?: string;
  shasum: string;
  url: string;
  permissionDiff?: string[];
};

/**
 * Trust tier the host is willing to render for a catalog entry.
 *
 * Issued by the plugin center, never asserted by a publisher: the host
 * downgrades a `verified` claim from any source other than the configured
 * official one, and renders an unrecognised tier as `unknown` (ADR 0102).
 */
export type MarketTrust = "verified" | "community" | "unknown";

/**
 * Source pin recorded for a published version.
 *
 * Evidence for a human decision before install, not an integrity control — it
 * is only as trustworthy as the catalog it came from, and the checksum stays
 * the mechanism that decides whether bytes are accepted.
 */
export type MarketProvenance = {
  /** Canonical https URL of the publisher's own repository. */
  sourceRepository: string;
  /** `refs/tags/<tag>` or a 40-hex commit, as submitted. */
  sourceRef?: string;
  /** Resolved 40-hex commit the artifact was built from. */
  sourceCommit?: string;
  /** Plugin directory inside that repository. */
  sourcePath?: string;
  builder?: string;
  builtAt?: string;
};

/** Publish verdict issued by the center's policy evaluator. */
export type MarketReview = {
  decision?: string;
  risk?: string;
  policyVersion?: string;
  reviewedAt?: string;
};

/** Distribution-side withdrawal of the exact version installed here. */
export type PluginYankNotice = {
  version: string;
  reason?: string;
};

export type PluginMarketplaceMeta = {
  providerId: string;
  shasum?: string;
  publisherId?: string;
  /** Trust tier accepted at install time, kept for later display. */
  trust?: MarketTrust;
  /** Source pin of the installed version, when the catalog carried one. */
  provenance?: MarketProvenance;
};

export type PluginUiMeta = {
  panel?: string;
  width?: number;
  height?: number;
  title?: string | PluginLocalizedString;
};

/**
 * One plugin-contributed work panel view, resolved for the current window.
 *
 * The renderer never reads a manifest: the main process resolves the localized
 * title against the active locale, filters by permission, activation scope, and
 * entry existence, and hands over only what the panel menu has to draw. `icon`
 * is a token from the SDK's closed list, not plugin markup.
 */
export type PluginViewMeta = {
  pluginId: string;
  /** Plugin-local view id from `contributes.views[].id`. */
  viewId: string;
  /** `<pluginId>/<viewId>` — the work panel tab's resource string. */
  ref: string;
  /** Already resolved against the host locale. */
  title: string;
  /** Owning plugin's display name, for tooltips and disambiguation. */
  pluginName: string;
  icon?: string;
  order: number;
};

/**
 * Which files one file mode may touch, straight from `manifest.fs`. Declared
 * here rather than imported from the plugin SDK because this package sits under
 * it: the SDK owns the matching and the host owns the enforcement, while this is
 * only the shape that reaches the UI so a user can see what they granted.
 */
export type PluginFsRule = {
  /** `workspace` unless the plugin asks the user to point at a directory. */
  root?: "workspace" | "userSelected";
  /** Globs relative to the root. Empty means "nothing without confirmation". */
  scope?: string[];
  /** Delete only: files the plugin wrote itself, which need no scope. */
  own?: boolean;
};

export type PluginFsPolicy = {
  read?: PluginFsRule;
  write?: PluginFsRule;
  delete?: PluginFsRule;
};

/** Localized plugin labels match the desktop shell's supported locales. */
export type PluginLocalizedString = {
  en: string;
  "zh-CN": string;
};

export type PluginCapability =
  | "panel"
  | "views"
  | "commands"
  | "tools"
  | "skills"
  | "themes"
  | "mcp"
  | "services"
  | "bus";

export type PluginSettingType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "json"
  | "shortcut";

export type PluginSettingOption = {
  label: string;
  value: string | number | boolean;
};

/** Declarative setting rendered by the installed-plugin settings surface. */
export type PluginSettingDefinition = {
  key: string;
  title: string;
  description?: string;
  type: PluginSettingType;
  default?: unknown;
  enum?: PluginSettingOption[];
  /** Shortcut settings invoke this plugin command in the app window. */
  command?: string;
  /** The first shortcut scope; global registration is intentionally not supported. */
  scope?: "plugin";
  /** Resolved private value, returned only to the owning plugin settings UI. */
  value?: unknown;
};

/** A theme contributed by a loaded plugin, with its sanitized CSS payload. */
export type PluginTheme = {
  /** `plugin:<pluginId>:<themeId>`; matches `AppSettings.theme`. */
  id: `plugin:${string}`;
  pluginId: string;
  themeId: string;
  label: string;
  /** Palette the overrides layer on; drives the `data-theme` attribute. */
  base: "light" | "dark";
  css: string;
};

export type PluginServiceState = "starting" | "running" | "stopped" | "failed";

/** Supervision state of one resident plugin service (spec 07 §5). */
export type PluginServiceStatus = {
  pluginId: string;
  serviceId: string;
  label: string;
  state: PluginServiceState;
  /** Host-process restarts this service survived since it was last started. */
  restarts: number;
  /** Why the service is `failed`. */
  message?: string;
  updatedAt: number;
};

export type PluginSummary = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  /** Where the plugin is allowed to run; absent records predate scopes. */
  scope?: ActivationScope;
  source: "installed" | "dev" | "marketplace";
  status: "ready" | "error" | "disabled" | "load_error";
  errorMessage?: string;
  permissions: string[];
  path?: string;
  /** Derived from the manifest by the host: which contribution kinds exist. */
  capabilities?: PluginCapability[];
  description?: string;
  author?: string;
  installedAt?: string;
  updatedAt?: string;
  marketplace?: PluginMarketplaceMeta;
  autoUpdate?: boolean;
  updateAvailable?: PluginUpdateInfo;
  /**
   * Set when the catalog withdrew the exact version installed here. The host
   * surfaces it and leaves the plugin running; withdrawal is a distribution
   * signal, not consent to disable working software.
   */
  yanked?: PluginYankNotice;
  ui?: PluginUiMeta;
  /** Declared file scope, so the page can show it next to the permissions. */
  fs?: PluginFsPolicy;
  settings?: PluginSettingDefinition[];
};

/** The filesystem level that owns an agent capability. */
export type AgentCapabilityLevel = "global" | "project";

/** A settings-page query for one capability column. */
export type AgentCapabilityQuery = {
  level: AgentCapabilityLevel;
  projectPath?: string;
};

/** Transport of an MCP server the user configured themselves. */
export type McpTransport = "stdio" | "http";

/**
 * An MCP server the user added directly, without a plugin around it.
 *
 * The shape deliberately mirrors `contributes.mcpServers` (ADR 0038) so both
 * kinds go through one client implementation; what differs is ownership. A user
 * server has no plugin to grant permissions to, so its consent is the act of
 * typing the command or the URL, and its credentials come from `env`/`headers`
 * on the record instead of a plugin's settings.
 */
export type McpServerRecord = {
  id: string;
  label: string;
  /** Filesystem ownership, present for the Agent settings management page. */
  level?: AgentCapabilityLevel;
  /** Project root when `level === "project"`. */
  projectPath?: string;
  /** Absolute config path; never used for activation state. */
  path?: string;
  description?: string;
  transport: McpTransport;
  /** stdio: executable name or absolute path. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: absolute endpoint; HTTP is allowed for local and LAN servers. */
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  scope?: ActivationScope;
  createdAt: string;
  updatedAt: string;
};

/** Fields accepted when creating or editing a user MCP server. */
export type McpServerInput = {
  id: string;
  label?: string;
  level?: AgentCapabilityLevel;
  projectPath?: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  scope?: ActivationScope;
};

export type McpConnectionState = "idle" | "connecting" | "ready" | "failed";

/** Live connection state of one user MCP server, as the Extensions page shows it. */
export type McpServerStatus = {
  serverId: string;
  state: McpConnectionState;
  /** Tools discovered by the last successful `tools/list`. */
  toolCount: number;
  toolNames?: string[];
  message?: string;
  updatedAt: number;
};

/** A user MCP server plus whatever the runtime knows about its connection. */
export type McpServerView = McpServerRecord & {
  status?: McpServerStatus;
};

/**
 * A skill document the user owns, stored under `~/.agents/skills` or a
 * project's `.agents/skills` directory.
 *
 * Reaches the model through the same catalog-plus-`Skill`-tool path as built-in
 * and plugin skills (D174), so the three are indistinguishable once loaded.
 */
export type UserSkillRecord = {
  /** Slug used both as the directory name and as the id the model passes. */
  id: string;
  name: string;
  /** Filesystem ownership, present for the Agent settings management page. */
  level?: AgentCapabilityLevel;
  /** Project root when `level === "project"`. */
  projectPath?: string;
  description?: string;
  enabled: boolean;
  scope?: ActivationScope;
  /** `created` writes a template; `imported` copies an existing document. */
  source: "created" | "imported";
  /** Absolute path of the document, for opening it in the editor. */
  path: string;
  /** Bytes of the document, so the list can flag one that grew past the cap. */
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type UserSkillInput = {
  id?: string;
  name: string;
  level?: AgentCapabilityLevel;
  projectPath?: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  scope?: ActivationScope;
};

/**
 * A global subagent definition the user owns, stored as `~/.agents/subagents/<id>.md`
 * (D202, ADR 0063). Project roots do not provide subagent definitions.
 *
 * `id` and `name` are deliberately the same string: the name
 * is the handle the model passes to `Task`, and keeping the document named after
 * it is what lets the UI tell which source won a name.
 */
export type UserSubagentRecord = {
  id: string;
  name: string;
  /** Subagents are global-only; the level is explicit for the settings API. */
  level?: "global";
  description: string;
  enabled: boolean;
  scope?: ActivationScope;
  /** Resolved tool grant, never empty — what the delegate may actually call. */
  tools: string[];
  /** `<provider>/<model>` pin, resolved against providers at launch. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  /** Absolute path of the document, for revealing it. */
  path: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type UserSubagentInput = {
  id?: string;
  name?: string;
  description?: string;
  body?: string;
  tools?: string[];
  /** Empty string clears the pin; absent leaves it unchanged. */
  model?: string;
  thinkingLevel?: ThinkingLevel | "";
  /** `0` clears the override; absent leaves it unchanged. */
  maxTurns?: number;
  enabled?: boolean;
  scope?: ActivationScope;
};

export type MarketPluginSummary = {
  id: string;
  name: string;
  description: string;
  author: string;
  iconUrl?: string;
  latestVersion: string;
  downloads?: number;
  updatedAt: string;
  categories?: string[];
  permissionSummary: string[];
  verified?: boolean;
  /** Catalog v2 trust tier, as the host is willing to render it. */
  trust?: MarketTrust;
  publisherId?: string;
  installed?: boolean;
  installedVersion?: string;
  updateAvailable?: boolean;
  /** False when `latestVersion` has no published package to download yet. */
  installable?: boolean;
  /** True when every catalog version of this plugin has been withdrawn. */
  yanked?: boolean;
};

export type MarketPluginDetail = MarketPluginSummary & {
  readmeMarkdown?: string;
  versions: Array<{
    version: string;
    publishedAt: string;
    changelog?: string;
    minPiDesktop?: string;
    shasum: string;
    url: string;
    sizeBytes: number;
    permissions: string[];
    /** Withdrawn: still listed in history, never offered for install. */
    yanked?: boolean;
    yankedReason?: string;
    provenance?: MarketProvenance;
    review?: MarketReview;
    signature?: string;
    signatureAlg?: string;
    keyId?: string;
  }>;
  screenshots?: string[];
  homepage?: string;
  repository?: string;
  permissions: string[];
  safetyNotes?: string;
};

export type PluginInstallResult = {
  plugin: PluginSummary;
  upgraded: boolean;
  permissionDiff: string[];
};

export type CommandItem = {
  id: string;
  title: string;
  category?: string;
  keywords?: string[];
  source: "builtin" | "plugin";
  pluginId?: string;
};

/** One entry of the composer "/" menu, merged from three sources (D123). */
export type ComposerCommand = {
  /** Slash name typed after "/"; unique across the merged list. */
  name: string;
  kind: "template" | "builtin" | "plugin";
  /** Display title (templates use their name). */
  title: string;
  description?: string;
  /** Template frontmatter `argument-hint`, shown as ghost text. */
  argumentHint?: string;
  /** Template provenance; project templates override user-global ones. */
  source?: "project" | "user";
  /** Palette command id for builtin/plugin execution. */
  id?: string;
};

/** One clipboard file transferred from the renderer to the composer bridge. */
export type ComposerPasteFile = {
  name?: string;
  mimeType?: string;
  data: ArrayBuffer;
};

/** A clipboard file materialized in the originating session's scratch root. */
export type ComposerPastedFile = {
  /** UUID-backed canonical path used by the prompt and file tools. */
  path: string;
  /** Sanitized original leaf name used only for compact composer display. */
  name: string;
  kind: "image" | "file";
  mimeType: string;
  size: number;
};

export type AppVersionInfo = {
  name: string;
  version: string;
  protocolVersion: number;
  hostProtocolVersion?: number;
  hostVersion?: string;
  platform: string;
  arch: string;
};

export type HostHealth = {
  ok: boolean;
  protocolVersion: number;
  version: string;
  uptimeMs: number;
};

/** Payload of the `hostStatus` push event (backend supervision state). */
export type HostStatusEvent = {
  ok: boolean;
  component?: "host" | "sidecar";
  restarting?: boolean;
  restarted?: boolean;
  fatal?: boolean;
  message?: string;
};

/**
 * How app updates are delivered on this install:
 *  - in-app: electron-updater downloads and installs (Windows NSIS, Linux AppImage)
 *  - manual: we only detect new versions and link to the releases page
 *    (unsigned macOS builds, Linux deb)
 *  - disabled: development / unpackaged build
 */
export type UpdateMode = "in-app" | "manual" | "disabled";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "downloaded"
  | "error";

/** Snapshot pushed on the `updatesState` event and returned by updates IPC. */
export type UpdateState = {
  mode: UpdateMode;
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  /**
   * Localized product highlights for `availableVersion` from the dual-locale
   * in-app changelog. Plain text (bullet lines); absent when the version has
   * no catalog entry. Main selects the locale — the renderer never supplies
   * a feed or remote notes URL (ADR 0022 / D164).
   */
  releaseNotes?: string;
  /** 0-100 while status is "downloading". */
  progressPercent?: number;
  error?: string;
  /** True when the transition came from a user-initiated check. */
  manual?: boolean;
  releasesUrl: string;
};

export type OnboardingState = {
  showChecklist: boolean;
  steps: Array<{
    id: string;
    title: string;
    done: boolean;
    action?: string;
  }>;
};


export type ScheduledTaskCadence = "manual" | "hourly" | "daily" | "weekly";

export type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  cadence: ScheduledTaskCadence;
  mode: Mode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
};

// --- Work panel (review / browser / files / plugin views) ---

export type DiffLineType = "add" | "del" | "context";

export type DiffLine = {
  type: DiffLineType;
  text: string;
};

export type DiffHunk = {
  /** Raw `@@ -a,b +c,d @@ …` header line. */
  header: string;
  lines: DiffLine[];
};

export type ReviewChangeOperation = "write" | "edit" | "delete";
export type ReviewChangeStatus = "added" | "modified" | "deleted";
export type ReviewChangeState = "active" | "rolledBack";

/**
 * Durable, message-owned change evidence returned by a workspace mutation.
 * Unlike WorkspaceDiff, this record remains valid after a git commit.
 */
export type ReviewChange = {
  version: 1;
  snapshotId: string;
  messageId: string;
  path: string;
  operation: ReviewChangeOperation;
  status: ReviewChangeStatus;
  state: ReviewChangeState;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reversible: boolean;
};

export type ReviewRollbackStatus =
  | "rolledBack"
  | "alreadyRolledBack"
  | "conflict"
  | "unavailable";

export type ReviewRollbackResult = {
  status: ReviewRollbackStatus;
  snapshotId: string;
  messageId?: string;
  path?: string;
};

export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Patch exceeded the per-file cap; hunks are omitted. */
  tooLarge?: boolean;
  hunks: DiffHunk[];
};

export type WorkspaceDiff = {
  /** Workspace root is a git work tree. */
  repo: boolean;
  /** No pending changes (only meaningful when repo). */
  clean: boolean;
  files: DiffFile[];
  /** File list hit the cap; more changes exist than listed. */
  truncated?: boolean;
};

export type BrowserAction = "back" | "forward" | "reload" | "stop";

export type BrowserState = {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type FsEntry = {
  name: string;
  kind: "dir" | "file";
  size: number;
};

export type FsReadResult = {
  kind: "text" | "image" | "binary" | "tooLarge";
  /** UTF-8 file content when kind is "text". */
  content?: string;
  /** Base64 data URL when kind is "image". */
  dataUrl?: string;
  size: number;
};

export type AgentInstructionFile = {
  scope: "global" | "project";
  path: string;
  content: string;
  exists: boolean;
};

/** Workspace-relative entry of the `fs/index` snapshot for the "@" menu (D124). */
export type FsIndexEntry = {
  path: string;
  kind: "dir" | "file";
};

export type FsIndexResult = {
  entries: FsIndexEntry[];
  /** True when the index hit its entry cap and results were dropped. */
  truncated: boolean;
};
