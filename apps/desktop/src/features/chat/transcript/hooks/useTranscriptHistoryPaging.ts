import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  captureTranscriptReadingPosition,
  isTranscriptReadingAnchorVisible,
  restoreTranscriptReadingPosition,
  type TranscriptReadingPosition,
} from "../../../../lib/transcript-reading-position";

type Hold = {
  position: TranscriptReadingPosition;
  settled: boolean;
  stableFrames: number;
  page: boolean;
  windowSize: number;
  sourceHead?: string;
  alignedHead?: string;
  height: number;
  top: number;
  viewport: number;
  scroller: HTMLDivElement;
};

const layoutChanged = (held: Hold, sourceHead: string | undefined) =>
  held.height !== held.scroller.scrollHeight || held.viewport !== held.scroller.clientHeight ||
  held.alignedHead !== sourceHead;

/** Single-flight page IO and pre-paint anchoring follow the reader's newest
 * position without blocking input. Cancelled IO cannot acquire a newer target. */
export function useTranscriptHistoryPaging({ scrollRef, contentRef, visible, sourceHead, onStart, onPosition, onSettled }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  sourceHead: string | undefined;
  onStart: () => void;
  onPosition: (top: number) => void;
  onSettled: () => void;
}) {
  const holdRef = useRef<Hold | null>(null);
  const inFlightRef = useRef(false);
  const frameRef = useRef(0);
  const autoBlockedRef = useRef(false);
  const latencyRef = useRef(250);
  const readLatency = useCallback(() => latencyRef.current, []);
  const sourceHeadRef = useRef(sourceHead);
  sourceHeadRef.current = sourceHead;
  const retry = useCallback(() => { autoBlockedRef.current = false; }, []);
  const [phase, setPhase] = useState<"idle" | "mount" | "page">("idle");
  const [, refresh] = useState(0);
  const callbacks = useRef({ onStart, onPosition, onSettled });
  callbacks.current = { onStart, onPosition, onSettled };

  const dropHold = useCallback(() => {
    holdRef.current = null;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);
  const cancel = useCallback(() => {
    dropHold();
    setPhase("idle");
  }, [dropHold]);
  const isHeld = useCallback(() => holdRef.current !== null, []);
  const track = useCallback(() => {
    const held = holdRef.current;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!held || !scroller || !content) return;
    // Retain the same readable message across a gesture. Switching immediately
    // to a newly exposed, estimated row lets its late layout move the text away.
    held.position = { ...held.position, offset: held.position.offset - (scroller.scrollTop - held.top),
      scrollTop: scroller.scrollTop };
    if (!layoutChanged(held, sourceHeadRef.current) &&
      !isTranscriptReadingAnchorVisible(scroller, content, held.position)) {
      const position = captureTranscriptReadingPosition(scroller, content, false, held.windowSize);
      if (position) held.position = position;
    }
    held.top = scroller.scrollTop;
  }, [contentRef, scrollRef]);
  const restore = useCallback(() => {
    const held = holdRef.current;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!held || !scroller || !content) return false;
    track();
    if (!layoutChanged(held, sourceHeadRef.current)) return false;
    const before = scroller.scrollTop;
    restoreTranscriptReadingPosition(scroller, content, held.position);
    held.height = scroller.scrollHeight;
    held.viewport = scroller.clientHeight;
    held.alignedHead = sourceHeadRef.current;
    held.top = scroller.scrollTop;
    if (Math.abs(scroller.scrollTop - before) > 1) held.stableFrames = 0;
    callbacks.current.onPosition(scroller.scrollTop);
    return true;
  }, [contentRef, scrollRef, track]);

  const run = useCallback((action: () => void | Promise<void>, windowSize: number, page = false) => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (holdRef.current || inFlightRef.current || autoBlockedRef.current || !scroller || !content) return;
    const position = captureTranscriptReadingPosition(scroller, content, false, windowSize)
      ?? { pinned: false, offset: 0, scrollTop: scroller.scrollTop, windowSize };
    const hold: Hold = { position, settled: false, stableFrames: 0, page, windowSize,
      sourceHead: sourceHeadRef.current, alignedHead: sourceHeadRef.current,
      height: scroller.scrollHeight, top: scroller.scrollTop, viewport: scroller.clientHeight,
      scroller };
    holdRef.current = hold; // Synchronous: two scroll events cannot start two pages.
    inFlightRef.current = true;
    callbacks.current.onStart();
    setPhase(page ? "page" : "mount");
    const startedAt = performance.now();
    const finish = () => {
      inFlightRef.current = false;
      if (holdRef.current !== hold) return;
      if (page) latencyRef.current = Math.min(2000, Math.max(latencyRef.current * 0.75, performance.now() - startedAt));
      hold.settled = true;
      // IO resolution is not a DOM commit. Render current history rather than
      // consuming an anchor on messages.length while deferred rows are stale.
      refresh(value => value + 1);
    };
    try {
      const result = action();
      void Promise.resolve(result).then(finish, (error: unknown) => {
        if (holdRef.current === hold) autoBlockedRef.current = true;
        finish();
        console.error("Transcript history page failed", error);
      });
    } catch (error) {
      if (holdRef.current === hold) autoBlockedRef.current = true;
      finish();
      console.error("Transcript history page failed", error);
    }
  }, [contentRef, scrollRef]);

  // Correct React commits synchronously, before paint, not on raw source length.
  useLayoutEffect(() => {
    if (!visible) { cancel(); return; }
    const hold = holdRef.current;
    if (!hold) return;
    restore();
    if (frameRef.current) return;
    const align = () => {
      frameRef.current = 0;
      if (holdRef.current !== hold) return;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const before = scroller.scrollTop;
      restore();
      const changed = Math.abs(scroller.scrollTop - before) > 1;
      hold.stableFrames = hold.settled && !changed ? hold.stableFrames + 1 : 0;
      if (hold.stableFrames >= 3) {
        // A failed/empty read must not loop at an unchanged visible boundary.
        if (hold.page && hold.sourceHead === sourceHeadRef.current) autoBlockedRef.current = true;
        dropHold();
        setPhase("idle");
        callbacks.current.onSettled();
        return;
      }
      frameRef.current = requestAnimationFrame(align);
    };
    frameRef.current = requestAnimationFrame(align);
  });

  // content-visibility estimates and late row measurements can change after a
  // layout effect. ResizeObserver runs before paint; a queued rAF alone is late.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller) return;
    const observer = new ResizeObserver(() => {
      const held = holdRef.current;
      if (!held) return;
      const before = scroller.scrollTop;
      restore();
      if (Math.abs(scroller.scrollTop - before) > 1) held.stableFrames = 0;
    });
    observer.observe(content, { box: "border-box" });
    observer.observe(scroller, { box: "border-box" });
    return () => observer.disconnect();
  }, [contentRef, restore, scrollRef]);

  useLayoutEffect(() => () => dropHold(), [dropHold]);

  return { loadingOlder: phase === "page", pending: phase !== "idle", run, restore, isHeld, track, cancel, retry, readLatency };
}
