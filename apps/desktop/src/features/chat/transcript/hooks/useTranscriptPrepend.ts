import { useCallback, useLayoutEffect, useReducer, useState, type RefObject } from "react";
import {
  createTranscriptPrependController,
  type TranscriptPrependFrame,
} from "../../../../lib/transcript-scroll";
import { growTranscriptWindow, TRANSCRIPT_WINDOW_MIN } from "../../../../lib/transcript-window";

/** Own the capture/request/commit lifecycle, not the store's page data. */
export function useTranscriptPrepend({
  scrollRef, paneVisible, sessionId, searchRequestId, readingWindow,
  hasMoreBefore, onLoadOlder, onPosition,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  paneVisible: boolean;
  sessionId: string | undefined;
  searchRequestId: number | undefined;
  readingWindow: boolean;
  hasMoreBefore: boolean;
  onLoadOlder?: () => Promise<void>;
  onPosition: (top: number) => void;
}) {
  const [controller] = useState(createTranscriptPrependController);
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW_MIN);
  // Also advances for an immediately completed/no-op read: batching true/false
  // loading state must not skip the layout that retires its unused capture.
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const invalidate = useCallback(() => {
    if (controller.cancel()) refresh();
  }, [controller]);

  // A retained pane still owns its in-flight read while hidden. Navigation
  // replaces that owner; visibility only suspends its geometry restoration.
  useLayoutEffect(invalidate, [invalidate, readingWindow, searchRequestId, sessionId]);
  useLayoutEffect(() => () => { controller.cancel(); }, [controller]);

  const reachTop = useCallback((retry = false) => {
    const el = scrollRef.current;
    const frame = controller.frame;
    if (!paneVisible || !el || !frame) return;
    const grown = readingWindow ? windowSize : growTranscriptWindow(windowSize, frame.historyLength);
    if (grown !== windowSize) {
      if (controller.begin("window", el)) setWindowSize(grown);
      return;
    }
    if (!hasMoreBefore || !onLoadOlder) return;
    const token = controller.begin("page", el, retry);
    if (!token) return;
    refresh();
    void (async () => {
      let failed = false;
      try {
        await onLoadOlder();
      } catch (error) {
        failed = true;
        // The store normally reports read errors; unexpected rejecting callers
        // must still be observable without leaving an unhandled rejection.
        console.error("Failed to load older transcript page", error);
      } finally {
        if (controller.settle(token, failed)) refresh();
      }
    })();
  }, [controller, hasMoreBefore, onLoadOlder, paneVisible, readingWindow, scrollRef, windowSize]);

  const commit = useCallback((frame: TranscriptPrependFrame, pinned: boolean) => {
    const top = controller.commit(frame, paneVisible ? scrollRef.current : null, pinned);
    if (top !== null) onPosition(top);
  }, [controller, onPosition, paneVisible, scrollRef]);

  const reanchor = useCallback(() => {
    const el = scrollRef.current;
    if (paneVisible && el) controller.reanchor(el);
  }, [controller, paneVisible, scrollRef]);

  return { windowSize, loadingOlder: controller.loading, revision, reachTop, invalidate, commit, reanchor };
}
