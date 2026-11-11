import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { stopSmoothScroll } from "../../../../lib/scroll-input";
import { createTranscriptLatestNavigation } from "../../../../lib/transcript-latest-navigation";

export function useTranscriptLatestNavigation({ scrollRef, visible }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
}) {
  const [navigation] = useState(() => createTranscriptLatestNavigation({
    geometry: () => scrollRef.current ?? undefined,
    move: (top, behavior) => scrollRef.current?.scrollTo({ top, behavior }),
    onScrollEnd: listener => {
      const scroller = scrollRef.current;
      const handle = (event: Event) => { if (event.target === scroller) listener(); };
      scroller?.addEventListener("scrollend", handle);
      return () => scroller?.removeEventListener("scrollend", handle);
    },
    stop: () => stopSmoothScroll(scrollRef.current),
    reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  // The explicit latest intent survives an immediate pane hide or eviction.
  // Reader input cancels without committing; it keeps the prepared history view.
  useLayoutEffect(() => { if (!visible) navigation.cancel(true); }, [navigation, visible]);
  useEffect(() => () => navigation.cancel(true), [navigation]);
  return navigation;
}
