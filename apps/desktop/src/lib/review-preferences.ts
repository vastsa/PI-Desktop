import type { ReviewContextLines } from "@pi-desktop/shared";

/** Profile-wide display preference, never session data or snapshot evidence. */
export const REVIEW_CONTEXT_STORAGE_KEY = "pi.desktop.reviewContextLines";

export function readReviewContextLines(): ReviewContextLines {
  try {
    const value = globalThis.localStorage?.getItem(REVIEW_CONTEXT_STORAGE_KEY);
    return value === "1" ? 1 : value === "5" ? 5 : 3;
  } catch {
    // Missing, blocked or malformed preferences retain the default display.
    return 3;
  }
}

export function rememberReviewContextLines(lines: ReviewContextLines): void {
  try {
    globalThis.localStorage?.setItem(REVIEW_CONTEXT_STORAGE_KEY, String(lines));
  } catch {
    // Best-effort UI persistence must not prevent changing the current view.
  }
}
