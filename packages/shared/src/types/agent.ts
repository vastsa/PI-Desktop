/** Shared public types grouped by the owning application domain. */
import type { AppError } from "../errors.js";
import type { PlanExecution, PlanningStateEvent } from "./plans.js";
import type { ContextCompactionFallback, ContextCompactionMark, ContextCompactionReason } from "./sessions.js";
import type { AgentStatus } from "./sessions.js";
import type { MessageUsage, ToolTokenUsage, UiMessage, VoiceOrigin } from "./messages.js";
import type { PermissionDecision, Risk } from "./permissions.js";
import type { ThinkingLevel } from "./models.js";
import type { RacpPermissionMode } from "../racp.js";

export type AgentPromptRequest = {
  sessionId: string;
  content: string;
  /** Host-owned collaboration delivery; its durable record supplies the input. */
  sessionMessageId?: string;
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
  /** Main-trusted source metadata for a Live Voice work admission. */
  voiceOrigin?: VoiceOrigin;
  /**
   * Renderer snapshot of the chat session visible when the prompt was sent.
   * Electron installs it before asynchronous turn setup for notification
   * suppression; missing, null, or mismatched values fail safe.
   */
  viewingSessionId?: string | null;
  /**
   * Per-turn permission ceiling override (spec §7.3): the effective mode the
   * remote layer computed for this specific turn, which the runtime must apply
   * for tool decisions instead of the session's stored mode. Absent means the
   * session's stored mode is used. Accepted only when the requested mode is
   * narrower than or equal to the session's mode; a wider request is refused
   * before the turn starts. The bridge forwards this end-to-end so the
   * host-core scoping (still pending, R1 leftover) can enforce it turn-locally
   * once it lands.
   */
  permissionMode?: RacpPermissionMode;
};

export type AgentPromptAttachment = {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  size?: number;
  /**
   * The `@path` text this attachment occupies inline in `content`. Electron main
   * fills it for an attachment the user's draft placed between words, so the
   * runtime keeps the image block at that position instead of trailing the
   * prompt text. Absent for older callers and formatted messages.
   */
  inlinePath?: string;
};

export type AgentSteerRequest = Pick<
  AgentPromptRequest,
  "sessionId" | "content" | "attachments" | "messageId" | "voiceOrigin"
> & {
  expectedTurnId: string;
};

export type AgentPromptResponse = {
  accepted: boolean;
  turnId: string;
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

/** One entry of the Host-owned turn queue as the renderer mirrors it (D386). */
export type QueuedTurnSummary = {
  id: string;
  sessionId: string;
  content: string;
  sessionMessageId?: string;
  userMessageId?: string;
  voiceOrigin?: VoiceOrigin;
  attachments?: AgentPromptAttachment[];
  position: number;
  /** Set only for promoted entries; entries arrive in delivery order. */
  priority?: number;
  createdAt: string;
};

export type AgentQueuePushRequest = {
  sessionId: string;
  content: string;
  sessionMessageId?: string;
  userMessageId?: string;
  voiceOrigin?: VoiceOrigin;
  attachments?: AgentPromptAttachment[];
  idempotencyKey?: string;
};

export type AgentQueueChangedEvent = {
  sessionId: string;
  entries: QueuedTurnSummary[];
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
  /** Immediate tool parent when this request came from nested execution. */
  nestedParentToolCallId?: string;
};

export type ToolPermissionResolution = {
  requestId: string;
  decision: PermissionDecision;
};

/** A selectable asktool answer: a plain label or a label with supporting copy. */
export type AskToolOption =
  | string
  | {
      label: string;
      description?: string;
    };

/** Normalize a model-provided asktool option and discard malformed/empty values. */
export function normalizeAskToolOption(value: unknown): AskToolOption | undefined {
  if (typeof value === "string") {
    const label = value.trim();
    return label || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const option = value as Record<string, unknown>;
  const label = typeof option.label === "string" ? option.label.trim() : "";
  if (!label) return undefined;
  const description =
    typeof option.description === "string" ? option.description.trim() : "";
  return description ? { label, description } : { label };
}

export function askToolOptionLabel(option: AskToolOption): string {
  return typeof option === "string" ? option : option.label;
}

export function askToolOptionDescription(
  option: AskToolOption,
): string | undefined {
  if (typeof option === "string") return undefined;
  const description = option.description?.trim();
  return description || undefined;
}

/** A model-created question shown in the inline asktool card. */
export type AskToolQuestion = {
  question: string;
  options: AskToolOption[];
  multiSelect?: boolean;
};

export type AskToolRequest = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  questions: AskToolQuestion[];
};

/**
 * Every interactive request one session is currently waiting on. Host state,
 * not connection state: a renderer that reloaded reads this instead of holding
 * a card that no longer exists, and it stays empty for a session with nothing
 * pending.
 */
export type PendingInteractiveRequests = {
  asks: AskToolRequest[];
  permissions: ToolPermissionRequest[];
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
  | { type: "usage"; usage: MessageUsage }
  | { type: "turn_end"; subagentUsage?: MessageUsage }
  | { type: "message_start"; message: UiMessage }
  | {
      type: "message_update";
      message: UiMessage;
      deltaText?: string;
      deltaThinking?: string;
      /**
       * Append-only streaming frame. Growing `content` / `thinking` are omitted
       * from `message`; apply `deltaText` / `deltaThinking` onto the live row.
       * Snapshot replacements omit this field and still carry a full `message`.
       */
      stream?: "delta";
      resetText?: boolean;
      resetThinking?: boolean;
    }
  | { type: "message_end"; message: UiMessage; precedingAssistant?: UiMessage; replacesMessageId?: string }
  | { type: "user_message_persisted"; optimisticMessageId: string; message: UiMessage }
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
  /** Immediate nested-tool parent; never identifies subagent ownership. */
  nestedParentToolCallId?: string;
  /** Definition name of the emitting subagent. */
  agentName?: string;
};
