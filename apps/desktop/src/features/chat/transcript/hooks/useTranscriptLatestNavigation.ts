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
    captureAnchor: () => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const node = scroller.ownerDocument.elementFromPoint(
        rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 120),
      )?.closest<HTMLElement>(".prose-chat p, .prose-chat li, .prose-chat pre, [data-message-id], [data-minimap-id]");
      if (!node || !scroller.contains(node)) return;
      const measure = () => node.isConnected && scroller.contains(node)
        ? node.getBoundingClientRect().top + scroller.scrollTop : undefined;
      return { top: measure() ?? 0, measure };
    },
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
