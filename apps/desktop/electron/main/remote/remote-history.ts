import type { RacpItemSummary, RacpSession, RacpSessionSnapshot, SessionDetail, UiMessage } from "@pi-desktop/shared";
import type { RemoteRacpClient } from "./remote-backend.js";
import { racpSessionToSummary } from "./remote-transcript.js";

export type RemoteHistoryReadOptions = { messageBefore?: number; messageLimit?: number };
// Process-wide virtual offsets avoid reusing a cursor after reconnect/re-pair.
let nextCursor = 2 ** 48;
const MAX_CURSORS = 1024;
const PAGE_LIMIT = 200;

/** Adapt numeric Desktop history windows to bounded, session-owned RACP cursors. */
export function createRemoteHistory(options: {
  client: RemoteRacpClient;
  hostLabel?: string;
  onSnapshot?: (snapshot: RacpSessionSnapshot) => void;
}) {
  const cursors = new Map<number, { sessionId: string; itemId: string }>();
  return {
    async read(remoteId: string, hostId: string, input: RemoteHistoryReadOptions = {}): Promise<SessionDetail> {
      const limit = Number.isFinite(input.messageLimit)
        ? Math.max(1, Math.min(PAGE_LIMIT, Math.floor(input.messageLimit!))) : 100;
      let session: RacpSession;
      let items: RacpItemSummary[];
      let hasMore: boolean;
      if (input.messageBefore !== undefined) {
        const cursor = cursors.get(input.messageBefore);
        if (!cursor || cursor.sessionId !== remoteId) {
          throw Object.assign(new Error("remote history cursor expired; reopen the conversation"), { errorCode: "INVALID_ARGUMENT" });
        }
        const [page, metadata] = await Promise.all([
          options.client.request<{ items: RacpItemSummary[]; hasMore: boolean }>("session/history", {
            sessionId: hostId, beforeItemId: cursor.itemId, limit,
          }),
          options.client.request<{ session: RacpSession }>("session/get", { sessionId: hostId }),
        ]);
        session = metadata.session;
        items = page.items;
        hasMore = page.hasMore && items.length > 0;
      } else {
        const result = await options.client.request<{ snapshot?: RacpSessionSnapshot }>("session/attach", {
          sessionId: hostId, includeSnapshot: true,
        });
        const snapshot = result.snapshot;
        if (!snapshot) throw Object.assign(new Error("remote host returned no snapshot"), { errorCode: "INTERNAL" });
        options.onSnapshot?.(snapshot);
        session = snapshot.session;
        const merged = new Map(snapshot.items.map((item) => [item.id, item]));
        for (const item of snapshot.activeItems ?? []) merged.set(item.id, item);
        items = [...merged.values()];
        hasMore = snapshot.hasMoreHistory || items.length > limit;
        items = items.slice(-limit);
      }
      let messageStart = 0;
      if (hasMore && items[0]) {
        messageStart = nextCursor--;
        cursors.set(messageStart, { sessionId: remoteId, itemId: items[0].id });
        while (cursors.size > MAX_CURSORS) cursors.delete(cursors.keys().next().value!);
      }
      return {
        ...racpSessionToSummary(remoteId, session, items.length, options.hostLabel),
        messages: items.map((item) => item.content as UiMessage),
        messageStart, hasMoreBefore: hasMore, hasMoreAfter: false,
      };
    },
  };
}
