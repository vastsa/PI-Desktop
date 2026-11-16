import { useSyncExternalStore } from "react";

/**
 * A one-shot "show these recorded changes" request from the transcript's
 * per-turn change summary to the Review tab. The originating session prevents
 * a retained request from being replayed in another conversation after remount.
 * Kept out of the app store because it is
 * transient UI intent, not session or panel state.
 */
export type ReviewFocusRequest = {
  /** Scrolled into view in order; the first one found becomes the anchor. */
  snapshotIds: readonly string[];
  sessionId?: string;
  /** Open each named change's diff, or only reveal the rows. */
  expand: boolean;
  seq: number;
};

let current: ReviewFocusRequest | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

export function requestReviewFocus(
  snapshotIds: readonly string[],
  { expand, sessionId }: { expand: boolean; sessionId?: string },
): void {
  if (snapshotIds.length === 0) return;
  sequence += 1;
  current = { snapshotIds: [...snapshotIds], expand, seq: sequence, ...(sessionId ? { sessionId } : {}) };
  for (const listener of listeners) listener();
}

export function currentReviewFocusRequest(): ReviewFocusRequest | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReviewFocusRequest(): ReviewFocusRequest | null {
  return useSyncExternalStore(subscribe, currentReviewFocusRequest, () => null);
}

export function scrollReviewToAnchor(scroller: HTMLElement | null, selector: string): void {
  const anchor = scroller?.querySelector<HTMLElement>(selector);
  if (!scroller || !anchor) return;
  // Ancestor scrolling can move the app shell and hide the window chrome.
  scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}
