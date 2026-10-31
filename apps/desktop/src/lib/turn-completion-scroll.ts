import type { UiMessage } from "@pi-desktop/shared";

/**
 * Turn-completion reading position (issue #1889). A reader who followed a
 * reply to its end is left at the bottom of a long answer and has to scroll
 * back to where it began. When the turn completes, the prompt that started it
 * moves to the top of the viewport so the answer reads from its start.
 */

/**
 * Gap kept above the prompt row, below the content's own top padding: that
 * padding reserves the titlebar band the conversation top bar overlays, so a
 * prompt aligned to the bare scroller edge would sit under the bar.
 */
export const TURN_COMPLETION_TOP_INSET_PX = 16;

export type SettledTurn =
  /** The reply is still streaming its final message. */
  | { kind: "pending" }
  /** The reply completed; `userMessageId` is the prompt row to show. */
  | { kind: "complete"; userMessageId: string }
  /** Failed, aborted, or no prompt/reply pair: leave the view alone. */
  | { kind: "none" };

/** Classify the newest turn once the session reports it is no longer running. */
export function settledTurn(messages: readonly UiMessage[]): SettledTurn {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return { kind: "none" };
  let reply: UiMessage | undefined;
  for (let index = messages.length - 1; index > userIndex; index--) {
    if (messages[index]?.role === "assistant") {
      reply = messages[index];
      break;
    }
  }
  if (!reply) return { kind: "none" };
  if (reply.status === "streaming") return { kind: "pending" };
  if (reply.status === "error" || reply.status === "aborted") return { kind: "none" };
  return { kind: "complete", userMessageId: messages[userIndex]!.id };
}

/**
 * Scroll offset that puts a row's top `inset` pixels below the viewport top,
 * or `null` when the row's top is already in view (a short reply needs no
 * move) or the geometry is unusable.
 */
export function turnAnchorScrollTop({
  rowTop,
  viewportTop,
  scrollTop,
  maxScrollTop,
  inset = TURN_COMPLETION_TOP_INSET_PX,
}: {
  rowTop: number;
  viewportTop: number;
  scrollTop: number;
  maxScrollTop: number;
  inset?: number;
}): number | null {
  const offset = rowTop - viewportTop;
  if (![offset, scrollTop, maxScrollTop].every(Number.isFinite)) return null;
  if (offset >= inset) return null;
  const target = Math.min(maxScrollTop, Math.max(0, scrollTop + offset - inset));
  return target < scrollTop ? target : null;
}

/**
 * Move `scroller` so the prompt row `userMessageId` sits at the top. Returns
 * whether it scrolled.
 */
export function scrollTurnPromptIntoView(
  scroller: HTMLElement,
  content: HTMLElement,
  userMessageId: string,
  behavior: ScrollBehavior,
): boolean {
  const row = content.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(userMessageId)}"]`,
  );
  if (!row) return false;
  const reserve = Number.parseFloat(getComputedStyle(content).paddingTop) || 0;
  const top = turnAnchorScrollTop({
    rowTop: row.getBoundingClientRect().top,
    viewportTop: scroller.getBoundingClientRect().top,
    scrollTop: scroller.scrollTop,
    maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
    inset: reserve + TURN_COMPLETION_TOP_INSET_PX,
  });
  if (top === null) return false;
  scroller.scrollTo({ top, behavior });
  return true;
}
