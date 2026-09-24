/**
 * Bounded transcript reads for remote sessions.
 *
 * The renderer pages a transcript by numeric offset (`messageStart`, then
 * `messageBefore: messageStart`), while RACP pages by item id
 * (`session/history { beforeItemId }`). A host transcript has no stable offset
 * the desktop could compute, so each page start is given a *virtual* offset: a
 * number minted here that maps back to the item it starts at. The numbers only
 * ever decrease, so the renderer's `Math.min` merge of page windows keeps the
 * oldest start, and a cursor is only meaningful to this module — an unknown or
 * foreign cursor is refused rather than guessed.
 */
import { ErrorCodes } from "@pi-desktop/shared";
import type {
  RacpCursor,
  RacpItemSummary,
  RacpSession,
  RacpSessionSnapshot,
  SessionDetail,
  UiMessage,
} from "@pi-desktop/shared";
import { remoteSessionSummary, type RemoteHostIdentity } from "./remote-transcript.js";

export type RemoteHistoryClient = {
  request<T>(method: string, params?: unknown): Promise<T>;
};

export type RemoteHistoryReadOptions = {
  messageBefore?: number;
  messageLimit?: number;
};

export type RemoteHistoryRead = {
  session: SessionDetail;
  /** The attach snapshot's cursor, for a tail read; absent for an older page. */
  cursor?: RacpCursor;
};

export type RemoteHistoryOptions = {
  client: RemoteHistoryClient;
  host: RemoteHostIdentity;
  /** How many page cursors are remembered; the oldest are forgotten first. */
  maxCursors?: number;
};

/** The host clamps a history page to this many items. */
export const REMOTE_HISTORY_PAGE_MAX = 200;
const DEFAULT_PAGE = 100;
/** A full read stops after this many pages and reports older history. */
const FULL_READ_MAX_PAGES = 50;
const DEFAULT_MAX_CURSORS = 1024;
/** Far above any real transcript offset, and exactly representable. */
const FIRST_CURSOR = 2 ** 48;

type HistoryPage = { items: RacpItemSummary[]; hasMore: boolean };
type AttachResult = { session: RacpSession; snapshot?: RacpSessionSnapshot };

function invalidCursor(): Error {
  return Object.assign(
    new Error("this history page is no longer available; reopen the conversation"),
    { errorCode: ErrorCodes.INVALID_ARGUMENT },
  );
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_PAGE;
  return Math.max(1, Math.min(Math.floor(limit), REMOTE_HISTORY_PAGE_MAX));
}

export type RemoteHistory = {
  read(
    remoteSessionId: string,
    hostSessionId: string,
    options?: RemoteHistoryReadOptions,
  ): Promise<RemoteHistoryRead>;
};

export function createRemoteHistory(options: RemoteHistoryOptions): RemoteHistory {
  const { client, host } = options;
  const maxCursors = Math.max(1, options.maxCursors ?? DEFAULT_MAX_CURSORS);
  const cursors = new Map<number, { remoteSessionId: string; itemId: string }>();
  let next = FIRST_CURSOR;

  const mint = (remoteSessionId: string, itemId: string): number => {
    const cursor = next--;
    cursors.set(cursor, { remoteSessionId, itemId });
    while (cursors.size > maxCursors) {
      const oldest = cursors.keys().next().value;
      if (oldest === undefined) break;
      cursors.delete(oldest);
    }
    return cursor;
  };

  const detail = (
    remoteSessionId: string,
    session: RacpSession,
    items: RacpItemSummary[],
    hasMoreBefore: boolean,
    messageStart: number,
  ): SessionDetail => {
    const messages = items.map((item) => item.content as UiMessage);
    return {
      ...remoteSessionSummary(remoteSessionId, session, host, messages.length),
      messages,
      messageStart,
      hasMoreBefore,
      hasMoreAfter: false,
    };
  };

  const startOf = (remoteSessionId: string, items: RacpItemSummary[], hasMore: boolean) =>
    hasMore && items.length > 0 ? mint(remoteSessionId, items[0]!.id) : 0;

  const readOlder = async (
    remoteSessionId: string,
    hostSessionId: string,
    before: number,
    limit: number | undefined,
  ): Promise<RemoteHistoryRead> => {
    const target = cursors.get(before);
    if (!target || target.remoteSessionId !== remoteSessionId) throw invalidCursor();
    const [page, { session }] = await Promise.all([
      client.request<HistoryPage>("session/history", {
        sessionId: hostSessionId,
        beforeItemId: target.itemId,
        limit: clampLimit(limit),
      }),
      client.request<{ session: RacpSession }>("session/get", { sessionId: hostSessionId }),
    ]);
    const start = startOf(remoteSessionId, page.items, page.hasMore);
    return { session: detail(remoteSessionId, session, page.items, page.hasMore, start) };
  };

  const readTail = async (
    remoteSessionId: string,
    hostSessionId: string,
    limit: number | undefined,
  ): Promise<RemoteHistoryRead> => {
    const attach = await client.request<AttachResult>("session/attach", {
      sessionId: hostSessionId,
      includeSnapshot: true,
    });
    const snapshot = attach.snapshot;
    if (!snapshot) {
      throw Object.assign(new Error("remote host returned no snapshot"), {
        errorCode: ErrorCodes.INTERNAL,
      });
    }
    let items = snapshot.items;
    let hasMore = snapshot.hasMoreHistory;
    if (limit !== undefined) {
      const bounded = Math.max(1, Math.floor(limit));
      if (items.length > bounded) {
        items = items.slice(items.length - bounded);
        hasMore = true;
      }
    } else {
      // No limit is a full read: page back until the host has no more, with a
      // page cap and an empty-page guard so a misbehaving host cannot spin us.
      for (let pages = 0; hasMore && items.length > 0 && pages < FULL_READ_MAX_PAGES; pages++) {
        const page = await client.request<HistoryPage>("session/history", {
          sessionId: hostSessionId,
          beforeItemId: items[0]!.id,
          limit: REMOTE_HISTORY_PAGE_MAX,
        });
        if (page.items.length === 0) {
          hasMore = false;
          break;
        }
        items = [...page.items, ...items];
        hasMore = page.hasMore;
      }
    }
    const start = startOf(remoteSessionId, items, hasMore);
    return {
      session: detail(remoteSessionId, snapshot.session, items, hasMore, start),
      cursor: snapshot.cursor,
    };
  };

  return {
    read(remoteSessionId, hostSessionId, readOptions = {}) {
      return readOptions.messageBefore !== undefined
        ? readOlder(remoteSessionId, hostSessionId, readOptions.messageBefore, readOptions.messageLimit)
        : readTail(remoteSessionId, hostSessionId, readOptions.messageLimit);
    },
  };
}
