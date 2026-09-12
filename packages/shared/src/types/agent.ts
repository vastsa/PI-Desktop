/** Shared public types grouped by the owning application domain. */
import type { AppError } from "../errors.js";
import type { PlanExecution, PlanningStateEvent } from "./plans.js";
import type { ContextCompactionFallback, ContextCompactionMark, ContextCompactionReason } from "./sessions.js";
import type { AgentStatus } from "./sessions.js";
import type { MessageUsage, ToolTokenUsage, UiMessage } from "./messages.js";
import type { PermissionDecision, Risk } from "./permissions.js";
import type { ThinkingLevel } from "./models.js";

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

export type AgentSteerRequest = Pick<
  AgentPromptRequest,
  "sessionId" | "content" | "attachments" | "messageId"
> & {
  expectedTurnId: string;
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

export type SessionSummarizeTitleRequest = {
  sessionId: string;
  userPrompt: string;
  assistantReply?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

export type SessionSummarizeTitleResponse = {
  title: string;
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
  attachments?: AgentPromptAttachment[];
  position: number;
  createdAt: string;
};

export type AgentQueuePushRequest = {
  sessionId: string;
  content: string;
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
  | { type: "turn_end"; subagentUsage?: MessageUsage }
  | { type: "message_start"; message: UiMessage }
  | {
      type: "message_update";
      message: UiMessage;
      deltaText?: string;
      deltaThinking?: string;
    }
  | { type: "message_end"; message: UiMessage; precedingAssistant?: UiMessage }
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
