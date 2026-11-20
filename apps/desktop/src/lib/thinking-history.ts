import type { SessionDetail, UiMessage } from "@pi-desktop/shared";
import type { SessionHistoryReadOptions } from "./api";
import { messageThinking } from "./assistant-turns";

type ThinkingHistoryOptions = {
  sessionId: string;
  liveMessages: readonly UiMessage[];
  readSession: (id: string, options?: SessionHistoryReadOptions) => Promise<{ session: SessionDetail | null }>;
  isCurrent: () => boolean;
};

/** Read on demand without retaining message bodies or replacing the UI window. */
export async function readThinkingMessageIds({ sessionId, liveMessages, readSession, isCurrent }: ThinkingHistoryOptions) {
  const seen = new Set<string>();
  const ids: string[] = [];
  const collect = (messages: readonly UiMessage[]) => {
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (!message.parentToolCallId && message.role === "assistant" && messageThinking(message)) ids.push(message.id);
    }
  };
  collect(liveMessages);
  const cursors = new Set<number>();
  let options: SessionHistoryReadOptions | undefined;
  while (isCurrent()) {
    const { session } = await readSession(sessionId, options);
    if (!isCurrent()) return;
    if (!session) throw new Error("Session unavailable");
    collect(session.messages);
    if (!session.hasMoreBefore) return ids;
    const cursor = session.messageStart;
    if (cursor === undefined || !Number.isSafeInteger(cursor) || cursor < 0 || cursors.has(cursor)) {
      throw new Error("Invalid or repeated history cursor");
    }
    cursors.add(cursor);
    options = { messageBefore: cursor };
  }
}
