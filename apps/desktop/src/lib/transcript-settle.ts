/**
 * Settle detection for a freshly mounted long transcript (D287).
 *
 * The bounded first commit, the expansion to the mounted window, and the row
 * heights that only resolve once Markdown, code blocks, and `content-visibility`
 * placeholders have laid out all land in different frames. Each one moves the
 * scroller's bottom, and a pinned transcript visibly chases it. Instead of
 * showing that chase, the pane keeps an opaque skeleton veil over the scroller
 * until the geometry has stopped changing, then fades the veil out.
 *
 * "Stopped changing" is measured, not guessed: the scroller's `scrollHeight`
 * and `clientHeight` have to read the same for several consecutive frames. A
 * hard time cap guarantees the veil always lifts, even when something keeps
 * resizing (an animated diagram, a slow image), so the reader is never locked
 * out of a transcript that is otherwise fine.
 */

/** Consecutive frames the scroller geometry must hold before the veil lifts. */
export const TRANSCRIPT_SETTLE_STABLE_FRAMES = 3;

/** Upper bound on how long the veil may cover a transcript, in milliseconds. */
export const TRANSCRIPT_SETTLE_MAX_MS = 600;

/** Duration of the veil's fade-out, matched by the stylesheet transition. */
export const TRANSCRIPT_VEIL_FADE_MS = 160;

export type TranscriptSettleSample = {
  scrollHeight: number;
  clientHeight: number;
};

export type TranscriptSettleState = {
  /** Geometry read in the previous frame, or `null` before the first sample. */
  last: TranscriptSettleSample | null;
  /** Frames in a row whose geometry matched the frame before. */
  stableFrames: number;
  /** `performance.now()` when sampling began. */
  startedAt: number;
};

export type TranscriptSettleStep = {
  state: TranscriptSettleState;
  settled: boolean;
  reason: "stable" | "timeout" | null;
};

export function createTranscriptSettleState(now: number): TranscriptSettleState {
  return { last: null, stableFrames: 0, startedAt: now };
}

/** Fold one frame's geometry into the settle state. */
export function reduceTranscriptSettle(
  state: TranscriptSettleState,
  sample: TranscriptSettleSample,
  now: number,
): TranscriptSettleStep {
  const unchanged =
    state.last !== null &&
    state.last.scrollHeight === sample.scrollHeight &&
    state.last.clientHeight === sample.clientHeight;
  const stableFrames = unchanged ? state.stableFrames + 1 : 0;
  const next: TranscriptSettleState = {
    last: sample,
    stableFrames,
    startedAt: state.startedAt,
  };
  if (stableFrames >= TRANSCRIPT_SETTLE_STABLE_FRAMES) {
    return { state: next, settled: true, reason: "stable" };
  }
  if (now - state.startedAt >= TRANSCRIPT_SETTLE_MAX_MS) {
    return { state: next, settled: true, reason: "timeout" };
  }
  return { state: next, settled: false, reason: null };
}

/** Skeleton rows painted on the veil: role and line widths, top to bottom. */
export const TRANSCRIPT_SKELETON_ROWS: ReadonlyArray<{
  role: "user" | "assistant";
  lines: readonly string[];
}> = [
  { role: "user", lines: ["46%"] },
  { role: "assistant", lines: ["92%", "84%", "61%"] },
  { role: "user", lines: ["38%", "24%"] },
  { role: "assistant", lines: ["88%", "95%", "72%", "43%"] },
  { role: "user", lines: ["52%"] },
  { role: "assistant", lines: ["90%", "66%"] },
];
