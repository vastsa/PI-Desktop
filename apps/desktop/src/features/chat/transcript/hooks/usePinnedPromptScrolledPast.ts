import { useEffect, useState } from "react";

import { isPinnedPromptScrolledPast, pinnedPromptSelector } from "../../../../lib/pinned-prompt";

/**
 * Whether the pinned prompt's row has left the top of the transcript.
 *
 * The row itself is the anchor: while any part of it is on screen the strip is
 * pointless, and once its bottom edge passes the scrollport's top edge the strip
 * takes over. Measurement rides the scroller's own scroll events, coalesced into
 * one frame, because the row's position changes with streaming layout too.
 */
export function usePinnedPromptScrolledPast({
  scrollRef,
  contentRef,
  messageId,
  enabled = true,
}: {
  scrollRef: { readonly current: HTMLElement | null };
  contentRef: { readonly current: HTMLElement | null };
  messageId: string | undefined;
  enabled?: boolean;
}): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !messageId || !scroller || !content) {
      setPast(false);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const row = content.querySelector<HTMLElement>(pinnedPromptSelector(messageId));
      if (!row) {
        setPast(false);
        return;
      }
      // +1 absorbs the sub-pixel gap a scaled display can leave at the edge.
      const next = isPinnedPromptScrolledPast(
        row.getBoundingClientRect().bottom,
        scroller.getBoundingClientRect().top + 1,
      );
      setPast((current) => (current === next ? current : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [contentRef, enabled, messageId, scrollRef]);

  return past;
}
