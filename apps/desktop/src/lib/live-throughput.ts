import { calculateTokenRate, estimateResponseOutputTokens } from "./context-usage";
import type { AssistantTurnEntry } from "./assistant-turns";
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
 * Whether the newest sample added output relative to the one before it.
 *
 * This is the "is the model generating right now" signal. It has to gate both
 * the displayed figure and the remembered one, because a window that straddles
 * the moment generation stopped still yields truthful — but steadily shrinking
 * — measurements. Letting those through makes the figure sag from 40 to 3 over
 * a long tool call, which reads as a crawling model rather than an idle one.
 */
export function sampleDidGrow(samples: readonly ThroughputSample[]): boolean {
  if (samples.length < 2) return false;
  const newest = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  return newest.tokens > previous.tokens;
}

/**
 * Tokens per second measured across the retained window, or `undefined` when
 * the window shows no growth to divide.
 *
 * Endpoints rather than summed per-interval deltas, so irregular sample spacing
 * — React can coalesce or skip renders — cannot bias the result.
 */
export function windowedTokenRate(
  samples: readonly ThroughputSample[],
): number | undefined {
  const newest = samples.at(-1);
  if (!newest) return undefined;
  const cutoff = newest.ts - LIVE_THROUGHPUT_WINDOW_MS;
  const oldest = samples.find((entry) => entry.ts >= cutoff) ?? samples[0];
  const spanMs = newest.ts - oldest.ts;
  if (spanMs < LIVE_THROUGHPUT_MIN_SPAN_MS) return undefined;
  return calculateTokenRate(newest.tokens - oldest.tokens, spanMs);
}

/**
 * What to display, given this tick's live measurement and the last one taken
 * while output was still arriving.
 *
 * Blanking the chip whenever generation pauses is the "hung model" reading this
 * feature exists to prevent, so the last real figure is held: unchanged through
 * a short gap, dimmed once the silence passes the stale threshold. The chip is
 * absent only before the turn has produced any measurement at all.
 */
export function retainLiveRate(
  fresh: number | undefined,
  remembered: { rate: number; at: number } | undefined,
  now: number,
): LiveTokenRate {
  if (fresh !== undefined) return { rate: fresh, stale: false };
  if (!remembered) return { stale: false };
  return {
    rate: remembered.rate,
    stale: now - remembered.at > LIVE_THROUGHPUT_STALE_MS,
  };
}

export type GenerationPhase = "waiting" | "thinking" | "generating" | "tool";
export type ThroughputMessage = Pick<UiMessage, "id" | "content" | "thinking" | "status">;

export function generationPhase(
  message: ThroughputMessage | undefined,
  toolRunning: boolean,
): GenerationPhase {
  if (toolRunning) return "tool";
  if (message?.status !== "streaming") return "waiting";
  if (message.content) return "generating";
  if (message.thinking) return "thinking";
  return "waiting";
}

/** Time-based smoothing gives the same response at different sampling cadences. */
export function smoothTokenRate(
  previous: number | undefined,
  next: number,
  elapsedMs: number,
): number {
  if (previous === undefined) return next;
  const weight = 1 - Math.exp(-Math.max(0, elapsedMs) / 750);
  return previous + weight * (next - previous);
}

export type ThroughputTracker = {
  messageId?: string;
  samples: ThroughputSample[];
  remembered?: { rate: number; at: number };
  smoothed?: { rate: number; at: number };
};

/** A new message or resumed generation starts a new window; history is display-only. */
export function advanceThroughput(
  previous: ThroughputTracker,
  message: ThroughputMessage | undefined,
  generating: boolean,
  now: number,
): { tracker: ThroughputTracker; view: LiveTokenRate } {
  let tracker = { ...previous };
  if (message?.id !== tracker.messageId || !generating) {
    tracker = { messageId: message?.id, samples: [], remembered: tracker.remembered };
  }
  let fresh: number | undefined;
  if (generating) {
    const tokens = sampleTokensForMessage(message);
    const last = tracker.samples.at(-1);
    // A replaced/truncated message cannot share a baseline with the old text.
    if (last && (tokens < last.tokens || now < last.ts)) {
      tracker.samples = [];
      tracker.smoothed = undefined;
    }
    tracker.samples = pushThroughputSample(tracker.samples, { ts: now, tokens });
    const raw = sampleDidGrow(tracker.samples) ? windowedTokenRate(tracker.samples) : undefined;
    if (raw !== undefined) {
      fresh = smoothTokenRate(
        tracker.smoothed?.rate, raw, now - (tracker.smoothed?.at ?? now),
      );
      tracker.smoothed = { rate: fresh, at: now };
      tracker.remembered = { rate: fresh, at: now };
    }
  }
  const view = retainLiveRate(fresh, tracker.remembered, now);
  // Outside generation the remembered number is explicitly historical immediately.
  if ((!generating || !tracker.smoothed) && view.rate !== undefined) view.stale = true;
  return { tracker, view };
}

/** Thinking-only messages live in activity parts, before an answer row exists. */
export function latestGenerationMessage(entry: AssistantTurnEntry): UiMessage | undefined {
  for (let index = entry.parts.length - 1; index >= 0; index--) {
    const part = entry.parts[index];
    if (part.kind === "message") return part.message;
    for (let item = part.items.length - 1; item >= 0; item--) {
      if (part.items[item].kind === "thinking") return part.items[item].message;
    }
  }
  return undefined;
}
