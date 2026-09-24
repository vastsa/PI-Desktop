import { calculateTokenRate, estimateResponseOutputTokens } from "./context-usage";
import type { AssistantTurnEntry } from "./assistant-turns";
import type { UiMessage } from "@pi-desktop/shared";

/** Renderer estimate of visible output; provider usage arrives at message_end. */
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
  /** True during tool/waiting phases or after output stops for the stale interval. */
  stale: boolean;
};

/** Uses ADR 0073’s visible thinking/text estimate, shared with stopped turns. */
export function sampleTokensForMessage(
  message: Pick<UiMessage, "content" | "thinking"> | undefined,
): number {
  if (!message) return 0;
  return estimateResponseOutputTokens(message) ?? 0;
}

/** Prunes the window, retaining one baseline when every prior sample is older. */
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

/** Only growth updates the rate; idle ticks must not dilute the retained value. */
export function sampleDidGrow(samples: readonly ThroughputSample[]): boolean {
  if (samples.length < 2) return false;
  const newest = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  return newest.tokens > previous.tokens;
}

/** Endpoint deltas keep irregular sample spacing from biasing the window rate. */
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

/** Retains the last measured rate through silence and dims it after the threshold. */
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
export type ThroughputMessage = Pick<UiMessage, "id" | "content" | "thinking" | "status" | "timeToFirstTokenMs">;

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
