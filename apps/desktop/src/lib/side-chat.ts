/**
 * Side chats: a follow-up conversation opened from a message.
 *
 * A side chat is an ordinary forked child session on the host, but the renderer
 * keeps it out of the visible conversation: it is registered against its parent
 * session and shown in the docked work panel, so the main transcript, its
 * composer draft, and its run state are never replaced (ADR message-quotes-and-side-chats / D-LOCAL-message-quotes).
 */
import type { WorkPanelTab } from "./work-panel-tabs";

export type SideChatEntry = {
  /** Child session created by `session.fork`. */
  sessionId: string;
  /** Conversation the side chat was opened from. */
  parentSessionId: string;
  /** Child session title, shown by the panel and kept in the sidebar. */
  title: string;
  /** Message the fork was anchored at, when it was opened from one. */
  anchorMessageId?: string;
  createdAt: number;
};

export type SideChatMap = Record<string, SideChatEntry>;

/** Tab ids are session-keyed so re-opening a side chat reuses its tab. */
export const SIDE_CHAT_TAB_PREFIX = "sidechat:";

export function sideChatWorkPanelTab(sessionId: string): WorkPanelTab {
  return {
    id: `${SIDE_CHAT_TAB_PREFIX}${sessionId}`,
    kind: "sidechat",
    resource: sessionId,
  };
}

export function isSideChatTab(
  tab: WorkPanelTab | null | undefined,
): tab is WorkPanelTab {
  return Boolean(tab) && tab?.kind === "sidechat";
}

/** The child session a side-chat tab shows, or null for any other tab. */
export function sideChatTabSessionId(
  tab: WorkPanelTab | null | undefined,
): string | null {
  if (!isSideChatTab(tab)) return null;
  const resource = (tab?.resource ?? "").trim();
  return resource ? resource : null;
}

export function sideChatEntry(
  input: Omit<SideChatEntry, "createdAt"> & { createdAt?: number },
): SideChatEntry {
  return {
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
    title: input.title,
    ...(input.anchorMessageId ? { anchorMessageId: input.anchorMessageId } : {}),
    createdAt: input.createdAt ?? Date.now(),
  };
}

/** Register (or re-register) a child session as a side chat of its parent. */
export function registerSideChat(
  chats: SideChatMap,
  entry: SideChatEntry,
): SideChatMap {
  return { ...chats, [entry.sessionId]: entry };
}

/** Drop one side chat. An unknown id returns the same map, not a fresh copy. */
export function removeSideChat(chats: SideChatMap, sessionId: string): SideChatMap {
  if (!chats[sessionId]) return chats;
  const next = { ...chats };
  delete next[sessionId];
  return next;
}

/**
 * Drop the side chats that must not outlive a deleted session: the session
 * itself, and every side chat reachable only through it.
 */
export function removeSideChatsForSessions(
  chats: SideChatMap,
  sessionIds: readonly string[],
): SideChatMap {
  const doomed = new Set(sessionIds);
  let kept = Object.values(chats);
  // Releasing cascades down the parent chain: a side chat opened from a released
  // session is no longer reachable from any conversation either, so dropping only
  // the first generation would strand children nobody can see or close.
  for (;;) {
    const next = kept.filter(
      (entry) =>
        !doomed.has(entry.sessionId) && !doomed.has(entry.parentSessionId),
    );
    if (next.length === kept.length) break;
    for (const entry of kept) {
      if (!next.includes(entry)) doomed.add(entry.sessionId);
    }
    kept = next;
  }
  if (kept.length === Object.keys(chats).length) return chats;
  return Object.fromEntries(kept.map((entry) => [entry.sessionId, entry]));
}

export function sideChatEntryForSession(
  chats: SideChatMap,
  sessionId: string,
): SideChatEntry | undefined {
  return chats[sessionId];
}

/** Side chats opened from one conversation, newest first. */
export function sideChatsForParent(
  chats: SideChatMap,
  parentSessionId: string | undefined,
): SideChatEntry[] {
  if (!parentSessionId) return [];
  return Object.values(chats)
    .filter((entry) => entry.parentSessionId === parentSessionId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function sideChatSessionIds(chats: SideChatMap): string[] {
  return Object.keys(chats);
}
