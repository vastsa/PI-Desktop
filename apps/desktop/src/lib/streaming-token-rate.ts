/**
 * Live conversation output rate (tok/s) for stream-health display.
 *
 * Prefer provider `outputTokens` when the runtime reports them mid-stream;
 * otherwise estimate from visible thinking+answer text with the same
 * four-code-points-per-token heuristic used for stopped-turn throughput.
 */

export type TokenRateSample = {
  atMs: number;
  /** Cumulative output tokens observed by this sample. */
  tokens: number;
};

export type WindowedTokenRateOptions = {
  /** Sliding window length. Default 2000ms. */
  windowMs?: number;
  /** Minimum elapsed time before a rate is reported. Default 200ms. */
  minDurationMs?: number;
};

export type StreamingOutputTokens = {
  tokens: number;
  /** True when tokens came from text estimate rather than provider usage. */
  estimated: boolean;
};

const DEFAULT_WINDOW_MS = 2_000;
const DEFAULT_MIN_DURATION_MS = 200;
const DEFAULT_RETAIN_MS = 12_000;

/**
 * Resolve the best available cumulative output token count for the live turn.
 */
export function resolveStreamingOutputTokens(input: {
  outputTokens?: number;
  content?: string;
  thinking?: string;
}): StreamingOutputTokens {
  const reported = input.outputTokens;
  if (
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported > 0
  ) {
    return { tokens: Math.round(reported), estimated: false };
  }

  const visible = `${input.thinking ?? ""}${input.content ?? ""}`.trim();
  if (!visible) return { tokens: 0, estimated: true };
  return {
    tokens: Math.max(1, Math.ceil(Array.from(visible).length / 4)),
    estimated: true,
  };
}

/**
 * True when mid-stream usage flips from a text estimate to provider
 * `outputTokens` and the provider count is lower than the estimate. Callers
 * must reset the sample window so monotonic clamping cannot freeze the rate
 * at a hard `0 tok/s` without `≈`.
 */
export function shouldResetTokenRateWindow(input: {
  wasEstimated: boolean;
  nowEstimated: boolean;
  previousTokens?: number;
  nextTokens: number;
}): boolean {
  if (!input.wasEstimated || input.nowEstimated) return false;
  if (
    typeof input.previousTokens !== "number" ||
    !Number.isFinite(input.previousTokens) ||
    !Number.isFinite(input.nextTokens)
  ) {
    return false;
  }
  return input.nextTokens < input.previousTokens;
}

/**
 * Append a cumulative sample, dropping entries older than the retain horizon.
 * Tokens are forced monotonic so a noisy estimate cannot go backwards.
 */
export function appendTokenSample(
  samples: readonly TokenRateSample[],
  next: TokenRateSample,
  nowMs = next.atMs,
  retainMs = DEFAULT_RETAIN_MS,
): TokenRateSample[] {
  if (
    !Number.isFinite(next.atMs) ||
    !Number.isFinite(next.tokens) ||
    next.tokens < 0
  ) {
    return samples.slice();
  }

  const retainBefore = nowMs - retainMs;
  const kept = samples.filter(
    (sample) =>
      Number.isFinite(sample.atMs) &&
      Number.isFinite(sample.tokens) &&
      sample.atMs >= retainBefore,
  );
  const last = kept[kept.length - 1];
  if (last && last.tokens === next.tokens && next.atMs - last.atMs < 40) {
    return kept;
  }
  const tokens = last ? Math.max(last.tokens, Math.round(next.tokens)) : Math.round(next.tokens);
  return [...kept, { atMs: next.atMs, tokens }];
}

/**
 * Sliding-window tokens/s from cumulative samples ending at `nowMs`.
 *
 * - Returns `undefined` when no positive output has been observed yet (hide
 *   the chip through TTFT), or when elapsed time is zero / below
 *   `minDurationMs` (not enough signal yet).
 * - Returns `0` only after positive output was seen and the window advanced
 *   without token growth (stall / reconnect), so the UI can show the stream
 *   is no longer producing.
 * - Concentrates a late burst into a high instantaneous rate by ignoring
 *   earlier growth outside the window.
 */
export function calculateWindowedTokenRate(
  samples: readonly TokenRateSample[],
  nowMs: number,
  options: WindowedTokenRateOptions = {},
): number | undefined {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const minDurationMs = options.minDurationMs ?? DEFAULT_MIN_DURATION_MS;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    !Number.isFinite(minDurationMs) ||
    minDurationMs < 0
  ) {
    return undefined;
  }

  const ordered = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.atMs) &&
        Number.isFinite(sample.tokens) &&
        sample.atMs <= nowMs &&
        sample.tokens >= 0,
    )
    .slice()
    .sort((left, right) => left.atMs - right.atMs);
  if (ordered.length === 0) return undefined;

  // Until some positive output exists, never report a stall `0` (false TTFT).
  if (!ordered.some((sample) => sample.tokens > 0)) return undefined;

  const first = ordered[0];
  const latest = ordered[ordered.length - 1];
  const windowStart = nowMs - windowMs;

  let startTokens = first.tokens;
  let startAt = first.atMs;
  let foundBeforeWindow = false;
  for (const sample of ordered) {
    if (sample.atMs <= windowStart) {
      startTokens = sample.tokens;
      startAt = windowStart;
      foundBeforeWindow = true;
    }
  }
  if (!foundBeforeWindow) {
    startTokens = first.tokens;
    startAt = first.atMs;
  }

  const durationMs = nowMs - startAt;
  if (durationMs <= 0 || durationMs < minDurationMs) return undefined;

  const deltaTokens = Math.max(0, latest.tokens - startTokens);
  return Math.round(deltaTokens / (durationMs / 1000));
}
