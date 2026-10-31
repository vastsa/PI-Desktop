import { useEffect, useRef, type RefObject } from "react";
import type { UiMessage } from "@pi-desktop/shared";

/** Continue a restored reading range without turning it into a manual search page. */
export function useTranscriptContinuation({
  scrollRef, contentRef, enabled, loading, messages, cursor, onLoadNewer,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  loading: boolean;
  messages: UiMessage[];
  cursor?: number;
  /** The reading service owns request coalescing, stale results and error reporting. */
  onLoadNewer?: () => Promise<void>;
}) {
  const attemptedRef = useRef<{ cursor?: number } | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || loading || !onLoadNewer || !scroller || !content) return;
    let requested = false;
    const check = () => {
      if (requested || scroller.clientHeight <= 0) return;
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 240) return;
      // A failed/empty page must not spin on loading, resize or queued scroll
      // events. New reading input can retry; new rows can fill a short viewport.
      if (attemptedRef.current?.cursor === cursor && attemptedRef.current !== null) return;
      requested = true;
      attemptedRef.current = { cursor };
      void onLoadNewer();
    };
    const onScroll = () => check();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const onInput = () => {
      attemptedRef.current = null;
      check();
    };
    const inputEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const event of inputEvents) scroller.addEventListener(event, onInput, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => check());
    observer?.observe(content);
    observer?.observe(scroller);
    check();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      for (const event of inputEvents) scroller.removeEventListener(event, onInput);
      observer?.disconnect();
    };
  }, [contentRef, cursor, enabled, loading, messages, onLoadNewer, scrollRef]);
}
