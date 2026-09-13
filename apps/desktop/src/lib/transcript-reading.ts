import type { SessionDetail, UiMessage } from "@pi-desktop/shared";
import { dedupeSessionMessages, mergeLiveSessionMessages } from "./session-transcript";

export type TranscriptSearchTarget = {
  sessionId: string;
  messageId: string;
  query: string;
  requestId: number;
};

/** One renderer reading range, shared by ordinary history and search navigation. */
export type TranscriptView = {
  messages: UiMessage[];
  messageStart: number;
  messageEnd?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  parentMessage?: UiMessage;
  focus: TranscriptSearchTarget | null;
  loading: "target" | "before" | "after" | null;
};

export const EMPTY_TRANSCRIPT: UiMessage[] = [];
export const TRANSCRIPT_PAGE_SIZE = 100;
export const TRANSCRIPT_SEARCH_PAGE_SIZE = 60;
export const TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;

export function transcriptViewFromSession(
  session: SessionDetail,
  focus: TranscriptSearchTarget | null = null,
): TranscriptView {
  return {
    messages: session.messages,
    messageStart: session.messageStart ?? 0,
    messageEnd: session.messageEnd,
    hasMoreBefore: session.hasMoreBefore === true,
    hasMoreAfter: session.hasMoreAfter === true,
    parentMessage: session.navigationParent,
    focus,
    loading: null,
  };
}

/** Live output remains authoritative outside an explicit historical search. */
export function transcriptViewMessages(live: UiMessage[], view?: TranscriptView): UiMessage[] {
  if (!view) return live;
  const liveById = new Map(live.map((message) => [message.id, message]));
  const messages = view.focus
    ? view.messages
    : mergeLiveSessionMessages(view.messages, live)
        // A reading snapshot can contain an older streaming row. Its status must
        // never outrank the canonical row, including a just-completed reply.
        .map((message) => liveById.get(message.id) ?? message);
  const parent = view.parentMessage;
  if (!parent) return messages;
  const index = messages.findIndex((message) => message.id === parent.id);
  if (index < 0) return [parent, ...messages];
  if (messages[index] === parent) return messages;
  // A neighboring page may contain an earlier physical copy of the Task.
  return messages.map((message) => (message.id === parent.id ? parent : message));
}

export function extendTranscriptView(
  view: TranscriptView,
  session: SessionDetail,
  direction: "before" | "after",
): TranscriptView {
  const messages = dedupeSessionMessages(
    direction === "before"
      ? [...session.messages, ...view.messages]
      : [...view.messages, ...session.messages],
  );
  const focused = view.messages.find((message) => message.id === view.focus?.messageId);
  if (focused) messages[messages.findIndex((message) => message.id === focused.id)] = focused;
  return {
    ...view,
    messages,
    messageStart: Math.min(view.messageStart, session.messageStart ?? 0),
    messageEnd: Math.max(view.messageEnd ?? 0, session.messageEnd ?? 0),
    hasMoreBefore: direction === "before" ? session.hasMoreBefore === true : view.hasMoreBefore,
    hasMoreAfter: direction === "after" ? session.hasMoreAfter === true : view.hasMoreAfter,
    loading: null,
  };
}

/** Hydrating or appending is safe; a canonical rewrite invalidates older snapshots. */
export function transcriptWasRewritten(previous: UiMessage[], next: UiMessage[]): boolean {
  const current = new Map(next.map((message) => [message.id, message]));
  return previous.some((message) => {
    const replacement = current.get(message.id);
    return (
      !replacement ||
      replacement.content !== message.content ||
      replacement.activeRevision !== message.activeRevision
    );
  });
}
