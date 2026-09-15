import { calculateTokenRate, estimateResponseOutputTokens } from "./context-usage";
import type { UiMessage } from "@pi-desktop/shared";

/**
 * Live generation throughput for the turn that is still streaming.
 *
 * The runtime has no incremental token source: provider usage is read once at
 * `message_end`, so a figure shown *during* the turn can only be an estimate.
 * This module owns that estimate and nothing else — sampling, windowing, and
 * staleness are pure functions so the React layer stays a thin shell.
 *
 * The window is deliberate. A cumulative average taken from the start of the
 * stream folds tool-execution wall clock into the denominator, so it sags after
 * every long `Bash` and reads as "the model got slow" when the model was simply
 * not running. Measuring only the recent window keeps the number about
 * generation speed, and silence is reported as staleness instead.
 */

/** Span the rate is measured over. */
export const LIVE_THROUGHPUT_WINDOW_MS = 3_000;
/** Minimum spacing between samples; the estimate walks the whole message. */
export const LIVE_THROUGHPUT_SAMPLE_MS = 250;
/** Silence past this point dims the figure instead of replacing it. */
export const LIVE_THROUGHPUT_STALE_MS = 1_500;
/** Below this span the sample set is too thin to put a number on screen. */
export const LIVE_THROUGHPUT_MIN_SPAN_MS = 600;
/** Backstop on the ring; the window normally bounds it well below this. */
export const LIVE_THROUGHPUT_MAX_SAMPLES = 120;

export type ThroughputSample = {
  ts: number;
  /** Cumulative estimated output tokens for the message, not a delta. */
  tokens: number;
};

export type LiveTokenRate = {
  /** Absent until the samples span `LIVE_THROUGHPUT_MIN_SPAN_MS` and grow. */
  rate?: number;
  /** True once the newest sample is older than `LIVE_THROUGHPUT_STALE_MS`. */
  stale: boolean;
};

/**
 * Estimated cumulative output tokens for a streaming assistant message.
 *
 * Delegates to the shared estimator so the live figure and the durable
 * stopped-turn figure use one convention: visible thinking plus answer text at
 * four Unicode code points per token (ADR 0073 §3).
 */
export function sampleTokensForMessage(
  message: Pick<UiMessage, "content" | "thinking"> | undefined,
): number {
  if (!message) return 0;
  return estimateResponseOutputTokens(message) ?? 0;
}

/**
 * Append a sample and drop the ones the window no longer needs.
 *
 * One sample older than the window is kept as the baseline: a slow stream would
 * otherwise never span enough time to produce a rate at all.
 */
export function pushThroughputSample(
  samples: readonly ThroughputSample[],
  sample: ThroughputSample,
): ThroughputSample[] {
  const cutoff = sample.ts - LIVE_THROUGHPUT_WINDOW_MS;
  const firstInWindow = samples.findIndex((entry) => entry.ts >= cutoff);
  // Keep the newest pre-window sample only when the window holds nothing else.
  const start = firstInWindow === -1 ? Math.max(0, samples.length - 1) : firstInWindow;
  const next = [...samples.slice(start), sample];
  return next.length > LIVE_THROUGHPUT_MAX_SAMPLES
    ? next.slice(next.length - LIVE_THROUGHPUT_MAX_SAMPLES)
    : next;
}

/**
 * Tokens per second across the retained window, plus whether it has gone quiet.
 *
 * The rate uses the window's endpoints rather than summing per-interval deltas,
 * so irregular sample spacing — React can coalesce or skip renders — cannot
 * bias it.
 */
export function liveTokenRate(
  samples: readonly ThroughputSample[],
  now: number,
): LiveTokenRate {
  const newest = samples.at(-1);
  if (!newest) return { stale: false };
  const stale = now - newest.ts > LIVE_THROUGHPUT_STALE_MS;
  const cutoff = newest.ts - LIVE_THROUGHPUT_WINDOW_MS;
  const oldest = samples.find((entry) => entry.ts >= cutoff) ?? samples[0];
  const spanMs = newest.ts - oldest.ts;
  if (spanMs < LIVE_THROUGHPUT_MIN_SPAN_MS) return { stale };
  const rate = calculateTokenRate(newest.tokens - oldest.tokens, spanMs);
  return rate === undefined ? { stale } : { rate, stale };
}
