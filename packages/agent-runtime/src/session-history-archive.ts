import { ErrorCodes, type ContextCompactionRecord, type UiMessage } from "@pi-desktop/shared";
import { hydrateAttachmentHistory, type AttachmentHistoryContext } from "./attachment-history.js";

const PAGE_MESSAGES = 32;

type HistoryRequest = { id: string; messageLimit: number; messageBefore?: number };
type HistoryWindow = {
  messages: UiMessage[];
  messageStart: number;
  messageEnd: number;
  hasMoreBefore: boolean;
  compaction?: ContextCompactionRecord;
};
type HistoryHost = { call<T>(method: string, params: HistoryRequest): Promise<T> };
type RestoreOptions = {
  attachmentContext: AttachmentHistoryContext;
  currentPrompt?: string;
  userMessageId?: string;
  hostStartedTurn?: boolean;
  backgroundCompletionId?: string;
  taskRowsOnly?: boolean;
};

/** Read the canonical transcript in bounded frames, leaving model and delegation replay unchanged. */
export async function readArchivedSessionHistory(
  host: HistoryHost,
  sessionId: string,
  options: RestoreOptions,
): Promise<{ history: UiMessage[]; compaction?: ContextCompactionRecord }> {
  let messageLimit = PAGE_MESSAGES;
  let messageBefore: number | undefined;
  let compaction: ContextCompactionRecord | undefined;
  let retainedBytes = 0;
  const newestById = new Map<string, UiMessage>();

  for (;;) {
    let page: HistoryWindow | null | undefined;
    try {
      const detail = await host.call<{ session?: HistoryWindow | null }>("session.get", {
        id: sessionId,
        messageLimit,
        ...(messageBefore !== undefined ? { messageBefore } : {}),
      });
      page = detail.session;
    } catch (error) {
      const failure = error as { errorCode?: unknown; data?: { errorCode?: unknown } } | null;
      if ((failure?.data?.errorCode ?? failure?.errorCode) !== ErrorCodes.LIMIT_EXCEEDED) throw error;
      if (messageLimit === 1) {
        throw Object.assign(new Error("Session history exceeds the RPC response limit even with a single message", { cause: error }), {
          errorCode: ErrorCodes.LIMIT_EXCEEDED,
        });
      }
      messageLimit = Math.max(1, Math.floor(messageLimit / 2));
      continue;
    }
    if (!page) {
      throw Object.assign(new Error("session not found while restoring history"), { errorCode: ErrorCodes.SESSION_NOT_FOUND });
    }
    const { messages, messageStart, messageEnd, hasMoreBefore } = page;
    if (
      !Number.isSafeInteger(messageStart) || !Number.isSafeInteger(messageEnd) ||
      messageStart < 0 || messageEnd < messageStart || messageEnd - messageStart > messageLimit ||
      hasMoreBefore !== (messageStart > 0) || !Array.isArray(messages) ||
      messages.length > messageEnd - messageStart ||
      (messageBefore !== undefined && (messageEnd !== messageBefore || messageStart >= messageBefore))
    ) {
      throw Object.assign(new Error("Invalid or changed transcript window while restoring session history"), {
        errorCode: ErrorCodes.INTERNAL,
      });
    }
    // The successful tail read fixes the end position and active checkpoint.
    // Earlier windows can carry historical dividers, and the live tail can grow.
    if (messageBefore === undefined) compaction = page.compaction;

    // Match host-core's first-position, last-payload deduplication across physical pages.
    // Moving duplicate keys avoids retaining an additional copy of their old payloads.
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (options.taskRowsOnly && !(message.role === "user" || message.toolName === "Task" || message.parentToolCallId)) continue;
      retainedBytes += new TextEncoder().encode(JSON.stringify(message)).length;
      if (retainedBytes > 16 * 1024 * 1024) throw Object.assign(new Error("Archived task history exceeds the on-demand restore budget"), { errorCode: ErrorCodes.LIMIT_EXCEEDED });
      const newest = newestById.get(message.id);
      newestById.delete(message.id);
      newestById.set(message.id, newest ?? message);
    }
    if (!hasMoreBefore) break;
    messageBefore = messageStart;
  }

  // The caller sends these rows separately. Exclude them before computing the
  // shared attachment byte budget, after resolving any duplicate payloads.
  const restored: UiMessage[] = [];
  for (const message of newestById.values()) {
    if (message.id === options.backgroundCompletionId) continue;
    if (options.currentPrompt !== undefined && message.role === "user" && message.id === options.userMessageId) continue;
    restored.push(message);
  }
  newestById.clear();
  restored.reverse();

  const history = await hydrateAttachmentHistory(restored, options.attachmentContext);
  // Older callers without a stable ID match the last user row by content.
  // An automatic continuation has no current user row to remove.
  if (options.currentPrompt !== undefined && !options.userMessageId && !options.hostStartedTurn) {
    const last = history.at(-1);
    if (last?.role === "user" && last.content === options.currentPrompt) history.pop();
  }
  return { history, ...(compaction ? { compaction } : {}) };
}


export async function readArchivedTaskRows(host: HistoryHost, sessionId: string): Promise<UiMessage[]> {
  return (await readArchivedSessionHistory(host, sessionId, { attachmentContext: { supportsVision: false }, taskRowsOnly: true })).history;
}
