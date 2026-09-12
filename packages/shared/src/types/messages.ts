/** Shared public types grouped by the owning application domain. */
import type { AppError } from "../errors.js";

export type UiMessageRole = "user" | "assistant" | "system" | "tool";

export type MessageUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
};

/** Sum two provider usage records. Used for turn rollups, never to rewrite a message. */
export function addUsage(
  total: MessageUsage | undefined,
  next: MessageUsage | undefined,
): MessageUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(total.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined
      ? {
          cacheReadTokens:
            (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
        }
      : {}),
    ...(total.cacheWriteTokens !== undefined ||
    next.cacheWriteTokens !== undefined
      ? {
          cacheWriteTokens:
            (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
        }
      : {}),
    ...(total.reasoningTokens !== undefined || next.reasoningTokens !== undefined
      ? {
          reasoningTokens:
            (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
        }
      : {}),
    totalTokens: total.totalTokens + next.totalTokens,
  };
}

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
  /** Accepted input to an existing turn; Stop must preserve it after reload. */
  steering?: boolean;
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
