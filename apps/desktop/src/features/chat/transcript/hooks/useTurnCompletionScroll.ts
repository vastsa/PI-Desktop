import { useEffect, useRef, type RefObject } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import {
  scrollTurnPromptIntoView,
  settledTurn,
} from "../../../../lib/turn-completion-scroll";

type UseTurnCompletionScrollOptions = {
  isRunning: boolean;
  paneVisible: boolean;
  readingWindow: boolean;
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Whether the reader is still following the stream at the bottom. */
  isFollowing: () => boolean;
  /** Called after the view moved, to leave follow mode at the new position. */
  onAnchored: () => void;
};

/**
 * When a turn this pane watched completes while the reader is still following
 * it, scroll its prompt to the top of the viewport (issue #1889). A reader who
 * scrolled away, a failed or aborted turn, a hidden pane, and a reply short
 * enough that its prompt is already in view all leave the view alone.
 */
export function useTurnCompletionScroll({
  isRunning,
  paneVisible,
  readingWindow,
  messages,
  scrollRef,
  contentRef,
  isFollowing,
  onAnchored,
}: UseTurnCompletionScrollOptions) {
  // Armed by a run this pane observed; spent by the first settled outcome.
  const armedRef = useRef(false);
  const frameRef = useRef(0);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const isFollowingRef = useRef(isFollowing);
  isFollowingRef.current = isFollowing;
  const onAnchoredRef = useRef(onAnchored);
  onAnchoredRef.current = onAnchored;

  useEffect(() => {
    if (!isRunning) return;
    armedRef.current = true;
    // A new run owns the view again; a queued completion move is stale.
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, [isRunning]);

  useEffect(() => {
    if (isRunning || !armedRef.current) return;
    const turn = settledTurn(messages);
    // The session stopped before the reply's final status arrived.
    if (turn.kind === "pending") return;
    armedRef.current = false;
    if (turn.kind !== "complete" || !paneVisible || readingWindow) return;
    if (!isFollowingRef.current()) return;
    cancelAnimationFrame(frameRef.current);
    // One frame lets the settled reply (action row, change summary) lay out
    // before the prompt's position is measured.
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const scroller = scrollRef.current;
      const content = contentRef.current;
      if (!scroller || !content) return;
      // A queued follow-up may have started, or the reader scrolled meanwhile.
      if (isRunningRef.current || !isFollowingRef.current()) return;
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      if (scrollTurnPromptIntoView(scroller, content, turn.userMessageId, behavior)) {
        onAnchoredRef.current();
      }
    });
  }, [contentRef, isRunning, messages, paneVisible, readingWindow, scrollRef]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
}
