/**
 * Context-estimate calibration.
 *
 * Every budget decision in this runtime reads one number: the context estimate
 * (the automatic compaction check, the idle pre-compaction, and the occupancy
 * the desktop shows). That number comes from pi's `estimateContextTokens`,
 * whose shape is:
 *
 *   last assistant usage (real, when the transcript still carries one)
 *     + ceil(chars / 4)  over every message after it
 *
 * Two systematic errors follow from that shape:
 *
 *   1. `chars / 4` is an English-prose constant. Applied to CJK text it
 *      under-counts by roughly a factor of two to four, and CJK is the bulk of
 *      what some sessions send. The test fixtures are ASCII, which is why the
 *      error never shows up in the suite.
 *   2. A projection with no assistant usage left — right after a compaction, or
 *      at the start of a session — is estimated end to end, so the system
 *      prompt and the tool schemas disappear from the number even though the
 *      next request still pays for them.
 *
 * The two errors are different quantities, so they are measured and corrected
 * separately:
 *
 *   - **trailing ratio** — while an anchor exists the estimator is exact up to
 *     the messages appended after it. `real - anchor` is the true size of those
 *     messages, and dividing it by the estimator's own trailing number is a
 *     pure measurement of the per-character bias.
 *   - **unanchored offset** — with no anchor, `real - estimate` is the missing
 *     system/tool overhead plus the same bias, so it is added back.
 *
 * A correction is applied only after `CONTEXT_CALIBRATION_MIN_SAMPLES`
 * observations, is the median of a bounded window (so one wild provider report
 * cannot move it), and is clamped both per series and on the final number. A
 * mis-calibration therefore cannot run away: the corrected value stays within a
 * factor of the raw one, and below the threshold the raw value is returned
 * unchanged.
 *
 * What this file is not
 * ---------------------
 * It does not estimate tokens, talk to a provider, or persist anything across
 * sessions. The runtime owns the observations; this owns the arithmetic. The
 * `view()` snapshot is what a caller can log, so a surprising occupancy can be
 * explained after the fact instead of guessed at.
 */

/** Observations needed before a series is trusted; below this the raw value stands. */
export const CONTEXT_CALIBRATION_MIN_SAMPLES = 3;

/** Bounded window per series: the median of these, so one outlier cannot move it. */
export const CONTEXT_CALIBRATION_WINDOW = 16;

/** Per-character bias may not be calibrated outside this range. */
export const CONTEXT_CALIBRATION_RATIO_MIN = 0.75;
export const CONTEXT_CALIBRATION_RATIO_MAX = 4;

/** The corrected value may not leave this band around the raw estimate. */
/**
 * The corrected value may not leave this band around the raw estimate. The
 * lower bound is the dangerous direction (a number that reads low postpones
 * compaction); the upper bound is generous on purpose, because an unanchored
 * projection can legitimately be missing a whole system prompt's worth of
 * overhead while its own content is only a few thousand tokens.
 */
export const CONTEXT_CALIBRATION_FACTOR_MIN = 0.5;
export const CONTEXT_CALIBRATION_FACTOR_MAX = 6;

/**
 * A provider report is only usable as a measurement of the *request*. Anything
 * outside this band is a misreport (a cached call that never carried the
 * context, a summary request, a gateway substituting a number), and folding it
 * into the median would corrupt both series at once.
 */
const CONTEXT_CALIBRATION_REAL_MAX_RATIO = 20;

/**
 * The residual series ignores ratios outside this band: a report that far off
 * is a misreport, and folding it in would widen the displayed band with noise
 * instead of accuracy.
 */
const CONTEXT_CALIBRATION_RESIDUAL_MIN = 0.25;
const CONTEXT_CALIBRATION_RESIDUAL_MAX = 4;

export type ContextCalibration = {
  /** Real tokens the estimator itself anchors on (the last assistant usage). */
  usageTokens: number;
  /** Estimated tokens for the messages after that anchor. */
  trailingTokens: number;
  /** Index of the anchor, or null when the projection carries no usage at all. */
  lastUsageIndex: number | null;
  /** The estimator's own total: anchor + trailing. Structurally this is the
   * object `estimateContextTokens` returns, so callers pass it straight in. */
  tokens: number;
};

export type CalibrationView = {
  anchoredSamples: number;
  trailingRatio: number;
  unanchoredSamples: number;
  unanchoredOffset: number;
  residualSamples: number;
  residualLowRatio: number;
  residualHighRatio: number;
  rawTokens: number;
  correctedTokens: number;
};

/**
 * The measured accuracy of the estimate, as the spread of real residuals. A
 * ratio of 1 means the prediction was exact; `lowRatio` below 1 means the
 * estimate read low (the dangerous direction) as recently as the window shows.
 */
export type ContextCalibrationBand = {
  samples: number;
  lowRatio: number;
  highRatio: number;
};

/** Median of a window; the window is never empty when this is called. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function usableNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Two rolling series, one per error above. Kept apart on purpose: a session
 * that has been compacted has both, and mixing them would apply the system
 * overhead twice on an anchored projection.
 */
export class ContextEstimateCalibration {
  private readonly trailingRatios: number[] = [];
  private readonly unanchoredOffsets: number[] = [];
  /** `real / predicted` per usable observation; the displayed band. */
  private readonly residuals: number[] = [];

  /**
   * Record one request whose estimate was anchored on a known usage.
   *
   * `trueTrailing` is derived by the caller as `real − usageTokens`: the anchor
   * is the estimator's own number for the prefix, so the difference is the
   * actual size of the messages the estimator had to guess at.
   */
  recordAnchored(
    usageTokens: number,
    estimatedTrailing: number,
    realTotal: number,
  ): void {
    if (!usableNumber(realTotal) || !usableNumber(usageTokens)) return;
    if (realTotal > usageTokens * CONTEXT_CALIBRATION_REAL_MAX_RATIO) return;
    const trueTrailing = realTotal - usageTokens;
    // A projection with nothing after the anchor carries no information about
    // the per-character bias; a negative one means the anchor over-counted,
    // which is not this series' error to absorb.
    if (!usableNumber(trueTrailing) || !usableNumber(estimatedTrailing)) return;
    // Measured before this observation joins the series: what the correction
    // would have predicted, against what the provider actually reported.
    this.recordResidual(
      usageTokens + estimatedTrailing * this.trailingRatio(),
      realTotal,
    );
    this.push(
      this.trailingRatios,
      clamp(
        trueTrailing / estimatedTrailing,
        CONTEXT_CALIBRATION_RATIO_MIN,
        CONTEXT_CALIBRATION_RATIO_MAX,
      ),
    );
  }

  /**
   * Record one request that had no anchor at all: the estimate covers every
   * message, so the measurement carries the missing system/tool overhead.
   */
  recordUnanchored(estimate: number, realTotal: number): void {
    if (!usableNumber(estimate) || !usableNumber(realTotal)) return;
    if (realTotal > estimate * CONTEXT_CALIBRATION_REAL_MAX_RATIO) return;
    this.recordResidual(estimate + this.unanchoredOffset(), realTotal);
    this.push(this.unanchoredOffsets, realTotal - estimate);
  }

  /**
   * Correct one raw estimate. Returns the raw value until its series has enough
   * observations, so a fresh session behaves exactly as it did before.
   */
  correct(raw: ContextCalibration): number {
    const rawTokens = Math.max(0, Math.round(raw.tokens));
    const anchored =
      raw.lastUsageIndex !== null && usableNumber(raw.usageTokens);
    let corrected: number;
    if (anchored) {
      // The anchored part is the provider's own number for the prefix and
      // already contains the system/tool overhead of that request, so only the
      // guessed tail is scaled — the unanchored offset must not be added here.
      corrected =
        raw.usageTokens +
        Math.max(0, raw.trailingTokens) * this.trailingRatio();
    } else {
      corrected = rawTokens + this.unanchoredOffset();
    }
    return this.clampCorrection(corrected, rawTokens);
  }

  /** The per-character bias currently believed, or 1 before there is evidence. */
  trailingRatio(): number {
    if (this.trailingRatios.length < CONTEXT_CALIBRATION_MIN_SAMPLES) return 1;
    return median(this.trailingRatios);
  }

  /** The overhead currently believed to be missing, or 0 before there is evidence. */
  unanchoredOffset(): number {
    if (
      this.unanchoredOffsets.length < CONTEXT_CALIBRATION_MIN_SAMPLES
    ) {
      return 0;
    }
    return median(this.unanchoredOffsets);
  }

  /** What the last `correct()` did, for logging and for tests. */
  view(rawTokens: number, correctedTokens: number): CalibrationView {
    const band = this.band();
    return {
      anchoredSamples: this.trailingRatios.length,
      trailingRatio: this.trailingRatio(),
      unanchoredSamples: this.unanchoredOffsets.length,
      unanchoredOffset: this.unanchoredOffset(),
      residualSamples: band.samples,
      residualLowRatio: band.lowRatio,
      residualHighRatio: band.highRatio,
      rawTokens,
      correctedTokens,
    };
  }

  /**
   * How far the corrected number has actually been from what the provider
   * reported, as a ratio (`real / predicted`) over the bounded window. This is
   * the band the estimate can honestly be displayed with: the spread of real
   * residuals, not a fabricated ±.
   */
  band(): ContextCalibrationBand {
    const samples = this.residuals.length;
    if (samples === 0) return { samples: 0, lowRatio: 1, highRatio: 1 };
    return {
      samples,
      lowRatio: Math.min(...this.residuals),
      highRatio: Math.max(...this.residuals),
    };
  }

  private recordResidual(predicted: number, realTotal: number): void {
    if (!usableNumber(predicted) || !usableNumber(realTotal)) return;
    const ratio = realTotal / predicted;
    if (!Number.isFinite(ratio)) return;
    if (
      ratio < CONTEXT_CALIBRATION_RESIDUAL_MIN ||
      ratio > CONTEXT_CALIBRATION_RESIDUAL_MAX
    ) {
      return;
    }
    this.push(this.residuals, ratio);
  }

  private push(series: number[], value: number): void {
    series.push(value);
    if (series.length > CONTEXT_CALIBRATION_WINDOW) series.shift();
  }

  private clampCorrection(corrected: number, rawTokens: number): number {
    if (!Number.isFinite(corrected)) return rawTokens;
    // A raw estimate of zero carries no scale to clamp against; the correction
    // is then whatever was measured, never negative.
    if (rawTokens <= 0) return Math.max(0, Math.round(corrected));
    return Math.round(
      clamp(
        corrected,
        rawTokens * CONTEXT_CALIBRATION_FACTOR_MIN,
        rawTokens * CONTEXT_CALIBRATION_FACTOR_MAX,
      ),
    );
  }
}

