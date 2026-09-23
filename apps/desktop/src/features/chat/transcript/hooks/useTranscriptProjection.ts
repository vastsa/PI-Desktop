import { useDeferredValue, useLayoutEffect, useMemo, useRef } from "react";
import type { ContextCompactionMark, UiMessage } from "@pi-desktop/shared";

/** Only streaming may lag; navigation must never regress to an older snapshot. */
export function useTranscriptProjection(
  messages: UiMessage[],
  compactions: ContextCompactionMark[] | undefined,
  immediate: boolean,
) {
  const snapshot = useMemo(
    () => [messages, compactions] as const,
    [messages, compactions],
  );
  const deferred = useDeferredValue(snapshot);
  const awaitingDeferredRef = useRef(false);
  const current = immediate || awaitingDeferredRef.current;
  useLayoutEffect(() => {
    // Keep a committed immediate projection until its deferred snapshot catches
    // up. An urgent follow-up must not shrink the DOM and clamp scrollTop.
    awaitingDeferredRef.current = current && snapshot !== deferred;
  }, [current, deferred, snapshot]);
  const [renderedMessages, renderedCompactions] = current ? snapshot : deferred;
  return { renderedMessages, renderedCompactions };
}
