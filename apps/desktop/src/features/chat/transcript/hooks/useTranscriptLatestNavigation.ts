import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createTranscriptLatestNavigation } from "../../../../lib/transcript-latest-navigation";

export function useTranscriptLatestNavigation({ scrollRef, visible, onPosition }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  onPosition: (top: number) => void;
}) {
  const position = useRef(onPosition);
  position.current = onPosition;
  const [navigation] = useState(() => createTranscriptLatestNavigation({
    geometry: () => scrollRef.current ?? undefined,
    move: top => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      scroller.scrollTo({ top, behavior: "instant" });
      position.current(scroller.scrollTop);
    },
    request: frame => requestAnimationFrame(frame),
    cancel: frame => cancelAnimationFrame(frame),
    now: () => performance.now(),
    reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  // The explicit latest intent survives an immediate pane hide or eviction.
  // Reader input cancels without committing; it keeps the prepared history view.
  useLayoutEffect(() => { if (!visible) navigation.cancel(true); }, [navigation, visible]);
  useEffect(() => () => navigation.cancel(true), [navigation]);
  return navigation;
}
