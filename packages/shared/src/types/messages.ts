/** Shared public types grouped by the owning application domain. */
import type { SessionMessageOrigin } from "../session-collaboration.js";
import type { AppError } from "../errors.js";

export type UiMessageRole = "user" | "assistant" | "system" | "tool";

/** Minimal provenance for an accepted Live Voice work input. */
export type VoiceOrigin = {
  callId: string;
  operationId: string;
};

export type MessageUsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type UsageProvenance = {
  /** Identifies one physical request, not a tool, artifact, or logical retry group. */
  operationId?: string;
  usageOrigin?: "pi" | "legacy";
  costStatus?: "reported" | "estimated" | "unknown";
  /** Physical billing binding, not a virtual model alias. */
  providerId?: string;
  modelId?: string;
};

export type MessageUsage = UsageProvenance & {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  cost?: MessageUsageCost;
  aggregation?: "operation" | "aggregate";
  /** Atomic records included in this rollup; never recursively nested. */
  operations?: UsageOperation[];
};

export type UsageOperation = Omit<MessageUsage, "operations" | "aggregation"> & {
  operationId: string;
};

export { addUsage, withUsageIdentity } from "../message-usage.js";

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
  /** Authenticated agent-to-agent provenance; never inferred from message text. */
  sessionMessage?: SessionMessageOrigin;
  /** Present only on the durable user row created by a Live Voice operation. */
  voiceOrigin?: VoiceOrigin;
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
   * Original text for an expanded slash template or explicit Skill invocation;
   * `content` holds the expanded text the model sees (D123, ADR 0219).
   */
  command?: string;
  /** Validated Skill tokens in `command`, using UTF-16 offsets. */
  skillMentions?: Array<{ start: number; end: number; id: string }>;
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
  /** Immediate tool-call parent, independent of the owning Task/subagent. */
  nestedParentToolCallId?: string;
  /** Definition name of the subagent that produced this row. */
  agentName?: string;
  /**
   * Provider-hosted web search activity for this assistant turn, extracted
   * from the vendor stream by the pi-ai adapters. Present only when the
   * model binding opted into native web search and the provider actually
   * searched.
   */
  hostedSearch?: HostedSearch;
};

/**
 * Normalized provider-hosted web search activity for one assistant message.
 * One message can run several search rounds server-side; each round is one
 * provider call (`server_tool_use` pair / `web_search_call` item) and renders
 * as its own transcript row.
 */
export type HostedSearch = {
  /** Aggregate of `rounds`: failed if any round failed, else searching while
   * any round is still in flight. */
  status: "searching" | "completed" | "failed";
  rounds: HostedSearchRound[];
  /**
   * Raw pi-ai hostedSearch content parts, in original block order. Display
   * uses `rounds`; convertMessages replay after a restart uses this. Absent
   * on transcripts written before the field existed — those rows still
   * render, but later turns cannot ground on the old search.
   */
  replay?: HostedSearchReplayBlock[];
};

/** One adapter-captured search block, stripped of streaming scratch. */
export type HostedSearchReplayBlock = {
  type: "hostedSearch";
  phase: string;
  blockId?: string;
  name?: string;
  input?: unknown;
  status?: string;
  isError?: boolean;
  wire?: unknown;
};

/** One provider search round, in the order the provider issued it. */
export type HostedSearchRound = {
  /** Stable key within the message: the provider block/item id when known. */
  id: string;
  status: "searching" | "completed" | "failed";
  /**
   * What the provider did this round. Responses `web_search_call` actions map
   * `search`/`open_page`/`find_in_page` onto these; an Anthropic
   * `web_fetch` server tool use is an `openPage`. Absent means a plain search.
   */
  kind?: "search" | "openPage" | "findInPage";
  /** The search query (or the in-page pattern for `findInPage`). */
  query?: string;
  /** The page a round opened, for `openPage`/`findInPage`. */
  url?: string;
  sources: HostedSearchSource[];
};

export type HostedSearchSource = {
  url: string;
  title?: string;
};

/** Terminal outcome of one background subagent run. TaskStop adds its own
 * `stopped` projection at the delegation registry layer. */
export type SubagentRunStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "timed_out";

/** Maximum number of Unicode code points accepted for a user-defined title. */
export const MAX_SESSION_TITLE_LENGTH = 80;
