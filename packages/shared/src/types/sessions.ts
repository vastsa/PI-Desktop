/** Shared public types grouped by the owning application domain. */
import type { Mode } from "./common.js";
import type { ThinkingLevel } from "./models.js";
import type { PermissionMode } from "./permissions.js";
import type { UiMessage } from "./messages.js";
import type { PlanningState } from "./plans.js";

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
  activity?: AgentActivity;
};

/** Bounded provider diagnostics shown while the runtime waits before retrying. */
export type AgentActivityError = {
  code: string;
  message: string;
  providerStatus?: number;
};

/** Coarse child-agent action shown while the parent waits on delegates. */
export type AgentActivityAgentPhase = "waiting-model" | "thinking" | "tool";

export type AgentActivityAgent = {
  name: string;
  lastPhase?: AgentActivityAgentPhase;
  lastToolName?: string;
};

/** The runtime phase that explains a quiet interval in an active turn. */
export type AgentActivity =
  | { phase: "starting"; since: number }
  | { phase: "waiting-model"; since: number }
  | { phase: "preparing"; since: number }
  | {
      phase: "compacting";
      since: number;
      reason: ContextCompactionReason;
    }
  | { phase: "recovering"; since: number }
  | {
      phase: "retrying";
      since: number;
      attempt: number;
      retryDelayMs?: number;
      error?: AgentActivityError;
    }
  | {
      phase: "waiting-subagents";
      since: number;
      subagentCount: number;
      /** Running targets, in wait order, with the latest coarse child action. */
      agents?: AgentActivityAgent[];
    };
