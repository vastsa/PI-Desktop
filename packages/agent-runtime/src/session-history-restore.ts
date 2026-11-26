import { ErrorCodes, type ContextCompactionRecord, type UiMessage } from "@pi-desktop/shared";
import { hydrateAttachmentHistory, type AttachmentHistoryContext } from "./attachment-history.js";

type RestoreOptions = {
  attachmentContext: AttachmentHistoryContext;
  currentPrompt?: string;
  userMessageId?: string;
  hostStartedTurn?: boolean;
  backgroundCompletionId?: string;
};
type HistoryHost = { call<T>(method: string, params: Record<string, unknown>): Promise<T> };
type RestoredContext = {
  messages: UiMessage[];
  compaction?: ContextCompactionRecord;
  overflow: boolean;
  omittedMessages: number;
  readBytes: number;
};

/** Restore the active model context, never the compacted transcript prefix. */
export async function restoreSessionHistory(host: HistoryHost, sessionId: string, options: RestoreOptions): Promise<{
  history: UiMessage[];
  compaction?: ContextCompactionRecord;
  recovery?: { omittedMessages: number; previousSummary?: string };
}> {
  const excludeMessageIds = [options.currentPrompt !== undefined ? options.userMessageId : undefined, options.backgroundCompletionId]
    .filter((id): id is string => Boolean(id));
  const detail = await host.call<{ session?: RestoredContext | null }>("session.restoreContext", { id: sessionId, excludeMessageIds });
  const page = detail.session;
  if (!page) throw Object.assign(new Error("session not found while restoring history"), { errorCode: "SESSION_NOT_FOUND" });
  if (!Array.isArray(page.messages) || typeof page.overflow !== "boolean" || !Number.isSafeInteger(page.readBytes) || page.readBytes < 0) {
    throw Object.assign(new Error("Invalid model context restore response"), { errorCode: ErrorCodes.INTERNAL });
  }
  const messages = page.messages.filter(message => !excludeMessageIds.includes(message.id));
  const history = await hydrateAttachmentHistory(messages, options.attachmentContext);
  if (options.currentPrompt !== undefined && !options.userMessageId && !options.hostStartedTurn) {
    const last = history.at(-1);
    if (last?.role === "user" && last.content === options.currentPrompt) history.pop();
  }
  return {
    history,
    ...(!page.overflow && page.compaction ? { compaction: page.compaction } : {}),
    ...(page.overflow ? { recovery: { omittedMessages: page.omittedMessages, previousSummary: page.compaction?.summary } } : {}),
  };
}
