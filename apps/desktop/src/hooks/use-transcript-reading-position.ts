import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  captureTranscriptReadingPosition,
  getTranscriptReadingPosition,
  restoreTranscriptReadingPosition,
  sessionReadingState,
  type TranscriptReadingPosition,
} from "../lib/transcript-reading-position";

export type RestoreTranscriptReading = (
  position: TranscriptReadingPosition,
  signal: AbortSignal,
) => Promise<boolean>;

/** A bounded initial alignment, cancelled by real input/navigation/new turns. */
export function useTranscriptReadingPosition({
  sessionId, scrollRef, contentRef, pinnedRef, visible, windowSize,
  contentVersion, onPosition, onRestore, onMissing,
}: {
  sessionId: string | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  pinnedRef: RefObject<boolean>;
  visible: boolean;
  windowSize: number;
  contentVersion: unknown;
  onPosition: (top: number) => void;
  onRestore?: RestoreTranscriptReading;
  onMissing: () => void;
}) {
  const [initialPosition] = useState(() => getTranscriptReadingPosition(sessionId));
  const pendingRef = useRef(initialPosition?.pinned === false ? initialPosition : undefined);
  const requestRef = useRef<AbortController | null>(null);
  const completedRestoreRef = useRef<TranscriptReadingPosition | null>(null);
  const restoreReadyRef = useRef(!onRestore);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const alignmentUntilRef = useRef(0);
  const wasVisibleRef = useRef(visible);
  useLayoutEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const bookmark = getTranscriptReadingPosition(sessionId);
      if (bookmark?.pinned === false) {
        // The follow flag can still read `true` when a send or retry hid the
        // pane; the recorded bookmark is the authoritative state for this
        // reveal, so claim the edge instead of letting follow bottom it.
        pendingRef.current = bookmark;
        pinnedRef.current = false;
      } else if (!pinnedRef.current) {
        pendingRef.current = bookmark;
      }
      alignmentUntilRef.current = 0;
    }
    wasVisibleRef.current = visible;
  }, [pinnedRef, sessionId, visible]);
  const cancel = useCallback(() => {
    pendingRef.current = undefined;
    requestRef.current?.abort();
  }, []);
  const remember = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!sessionId || !visible || !scroller || !content || pendingRef.current) return;
    const position = captureTranscriptReadingPosition(scroller, content, pinnedRef.current, windowSize);
    if (position) sessionReadingState(sessionId).position = position;
  }, [contentRef, pinnedRef, scrollRef, sessionId, visible, windowSize]);
  const callbacks = useRef({ remember, onMissing });
  callbacks.current = { remember, onMissing };

  // Fetch only if the row is outside the current range. Abort also invalidates
  // completion when a pane hides/unmounts, or the reader takes over during IO.
  useLayoutEffect(() => {
    const position = pendingRef.current;
    if (!visible || !position || !onRestore || completedRestoreRef.current === position) return;
    // Do not start the bounded alignment window while the target may still be
    // loading. A slow history read must not be aborted by the fallback timer.
    restoreReadyRef.current = false;
    const controller = new AbortController();
    requestRef.current = controller;
    void onRestore(position, controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      if (found) {
        completedRestoreRef.current = position;
        restoreReadyRef.current = true;
        setRestoreRevision((revision) => revision + 1);
        return;
      }
      cancel();
      callbacks.current.onMissing();
      callbacks.current.remember();
    });
    return () => controller.abort();
  }, [cancel, onRestore, visible]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!visible) {
      alignmentUntilRef.current = 0;
      return;
    }
    if (!pendingRef.current || !scroller || !content) return;
    if (!restoreReadyRef.current) return;
    let timer = 0;
    const align = () => {
      const position = pendingRef.current;
      if (!position || !restoreReadyRef.current) return;
      if (alignmentUntilRef.current && performance.now() >= alignmentUntilRef.current) {
        cancel();
        callbacks.current.remember();
        return;
      }
      if (!restoreTranscriptReadingPosition(scroller, content, position)) return;
      onPosition(scroller.scrollTop);
      if (!alignmentUntilRef.current) {
        alignmentUntilRef.current = performance.now() + 1500;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        cancel();
        callbacks.current.remember();
      }, Math.max(0, alignmentUntilRef.current - performance.now()));
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [cancel, contentRef, contentVersion, onPosition, onRestore, restoreRevision, scrollRef, visible]);

  // Save laid-out geometry as well as native scrolls (e.g. disclosure changes).
  useLayoutEffect(() => {
    if (!visible) return;
    const content = contentRef.current;
    const observer = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(remember) : null;
    if (content) observer?.observe(content);
    remember();
    return () => observer?.disconnect();
  }, [contentRef, remember, visible]);

  return { initialPosition, pendingRef, remember, cancel };
}
