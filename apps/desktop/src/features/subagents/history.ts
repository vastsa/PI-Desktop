import { subagentTaskDisplayMessage, type SessionDetail, type UiMessage } from "@pi-desktop/shared";
import type { SessionHistoryReadOptions } from "../../lib/api";
import { delegationLifecycleKind, isDelegationStartTool } from "../../lib/tool-display";
import { toolResultPayload } from "../../lib/tool-presentation";

export const SUBAGENT_HISTORY_PAGE_SIZE = 256;
export const SUBAGENT_INDEX_SCAN_PAGES = 4;
export type SubagentSessionReader = (
  id: string,
  options: SessionHistoryReadOptions,
) => Promise<{ session: SessionDetail | null }>;
export type SubagentHistoryPage = {
  messages: UiMessage[];
  before?: number;
  after?: number;
  hasMore: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function pick(value: unknown, names: readonly string[]): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(names.filter((name) => source[name] !== undefined)
    .map((name) => [name, source[name]]));
}

/** Keep identities/status only: the directory never retains child transcripts/reports. */
function indexRow(source: UiMessage): UiMessage | null {
  const message = subagentTaskDisplayMessage(source);
  if (message.role !== "tool" || message.parentToolCallId) return null;
  const task = isDelegationStartTool(message.toolName);
  if (!task && !delegationLifecycleKind(message.toolName)) return null;
  const payload = record(toolResultPayload(message));
  const fields = ["delegationId", "agent", "status", "modelId", "thinkingLevel"];
  const details = task ? pick(payload, fields) : Object.fromEntries(
    ["delegations", "stopped"].filter((name) => Array.isArray(payload[name]))
      .map((name) => [name, (payload[name] as unknown[]).map((entry) => pick(entry, fields))]),
  );
  return {
    id: message.id, role: "tool", content: "", createdAt: message.createdAt,
    toolName: message.toolName, toolCallId: message.toolCallId,
    toolStatus: message.toolStatus, status: message.status,
    toolArgs: task ? pick(message.toolArgs, ["agent", "task", "description", "resume"]) : {},
    toolResult: { details },
  };
}

function sessionPage(result: { session: SessionDetail | null }, sessionId: string): SessionDetail {
  if (!result.session || result.session.id !== sessionId) {
    throw new Error("Subagent history session is unavailable");
  }
  return result.session;
}

function validCursor(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** Scan a bounded batch backwards; the caller explicitly exposes remaining history. */
export async function readSubagentIndexPage(
  read: SubagentSessionReader,
  sessionId: string,
  before?: number,
  signal?: AbortSignal,
): Promise<SubagentHistoryPage> {
  let cursor = before;
  let hasMore = false;
  let messages: UiMessage[] = [];
  for (let page = 0; page < SUBAGENT_INDEX_SCAN_PAGES; page += 1) {
    signal?.throwIfAborted();
    const session = sessionPage(await read(sessionId, {
      messageLimit: SUBAGENT_HISTORY_PAGE_SIZE, contentLimit: 512,
      ...(cursor === undefined ? {} : { messageBefore: cursor }),
    }), sessionId);
    signal?.throwIfAborted();
    const rows = session.messages.map(indexRow).filter((row): row is UiMessage => row !== null);
    messages = [...rows, ...messages];
    hasMore = session.hasMoreBefore === true;
    const next = session.messageStart;
    if (hasMore && (!validCursor(next) || next === 0 ||
      (cursor !== undefined && next >= cursor))) {
      throw new Error("Invalid subagent history cursor");
    }
    cursor = next;
    if (!hasMore || rows.some((row) => isDelegationStartTool(row.toolName))) break;
  }
  return { messages, before: cursor, hasMore };
}

/** An independent reader anchored to one chain; no main transcript/store mutation. */
export async function readSubagentTranscriptPage(
  read: SubagentSessionReader,
  sessionId: string,
  callIds: readonly string[],
  after?: number,
  signal?: AbortSignal,
): Promise<SubagentHistoryPage> {
  if (callIds.length === 0) throw new Error("A subagent Task anchor is required");
  signal?.throwIfAborted();
  const session = sessionPage(await read(sessionId, {
    messageLimit: SUBAGENT_HISTORY_PAGE_SIZE, contentLimit: 8_000,
    ...(after === undefined ? { messageAround: callIds[0] }
      : { messageBefore: after + SUBAGENT_HISTORY_PAGE_SIZE }),
  }), sessionId);
  signal?.throwIfAborted();
  const hasMore = session.hasMoreAfter === true;
  const cursor = session.messageEnd;
  if (hasMore && (!validCursor(cursor) || (after !== undefined && cursor <= after))) {
    throw new Error("Invalid subagent transcript cursor");
  }
  const own = new Set(callIds);
  const owns = (message: UiMessage) => message.parentToolCallId
    ? own.has(message.parentToolCallId)
    : isDelegationStartTool(message.toolName) && own.has(message.toolCallId ?? message.id);
  const messages = session.messages.filter(owns);
  if (session.navigationParent && owns(session.navigationParent) &&
    !messages.some((message) => message.id === session.navigationParent?.id)) {
    messages.unshift(session.navigationParent);
  }
  return { messages, after: cursor, hasMore };
}
