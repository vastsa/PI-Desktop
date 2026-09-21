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
 *      what some sessions send. ASCII fixtures never show it.
 *   2. A projection with no assistant usage left — right after a compaction, or
 *      at the start of a session — is estimated end to end, so the system
 *      prompt and the tool schemas disappear from the number even though the
 *      next request still pays for them.
 *
 * The two errors are different quantities, so they are measured and applied
 * separately:
 *
 *   - **trailing ratio** — while an anchor exists the estimator is exact up to
 *     the messages appended after it. `real - usage` is the true size of those
 *     messages, and dividing it by the estimator's own trailing number is a
 *     pure measurement of the per-character bias. It is a ratio, so it is
 *     scale-free: the same correction applies whether the tail is 2k or 200k
 *     tokens.
 *   - **unanchored residual** — with no anchor, `real - estimate` carries the
 *     missing system/tool overhead *and* the same per-character bias. Those two
 *     are split here rather than added together: a residual ratio is applied
 *     only when the observation was taken at a comparable scale
 *     (`CONTEXT_CALIBRATION_SCALE_BAND_*` of the estimate being corrected),
 *     and otherwise only the fixed part — the observed overhead, capped by
 *     `CONTEXT_CALIBRATION_OVERHEAD_CAP` — is added. A sample taken in a 100k
 *     session therefore cannot be applied as a ratio to a 1M projection.
 *
 * Safety properties, because this number gates compaction:
 *
 *   - **Asymmetric.** Upward correction applies as soon as there is evidence;
 *     downward correction needs `CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE`
 *     agreeing samples, is capped at `CONTEXT_CALIBRATION_DOWNWARD_STEP_MAX`
 *     per step, and can never take the corrected value below
 *     `CONTEXT_CALIBRATION_FACTOR_MIN` of the raw estimate. A projection that
 *     reads at or above `CONTEXT_CALIBRATION_BOUNDARY_GUARD_RATIO` of the hard
 *     limit therefore still reaches it after correction — a session cannot be
 *     carried past the boundary by its own corrections.
 *   - **Sanity-checked.** A provider report outside
 *     `CONTEXT_CALIBRATION_SAMPLE_*_RATIO` of what the calibration predicted is
 *     treated as a misreport: it is discarded and counted, and
 *     `CONTEXT_CALIBRATION_ANOMALY_FREEZE` consecutive ones freeze the downward
 *     direction until a usable report arrives.
 *   - **Bounded windows and medians.** Each series is the median of its last
 *     `CONTEXT_CALIBRATION_WINDOW` samples, so one wild report cannot move it.
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

/** Per-character bias may not be calibrated outside this range. Scale-free. */
export const CONTEXT_CALIBRATION_RATIO_MIN = 0.75;
export const CONTEXT_CALIBRATION_RATIO_MAX = 4;

/**
 * The corrected value may not leave this band around the raw estimate. The
 * lower bound is the dangerous direction — a number that reads low postpones
 * compaction — so it is a hard floor that no combination of samples can pass,
 * while the upper bound stays generous: an unanchored projection can
 * legitimately be missing a whole system prompt's worth of overhead.
 */
export const CONTEXT_CALIBRATION_FACTOR_MIN = 0.85;
export const CONTEXT_CALIBRATION_FACTOR_MAX = 6;

/** A projection at or above this share of the hard limit still compacts. */
export const CONTEXT_CALIBRATION_BOUNDARY_GUARD_RATIO =
  1 / CONTEXT_CALIBRATION_FACTOR_MIN;

/**
 * A provider report is only usable as a measurement of the *request*. Outside
 * this band around what the calibration predicted, it is a misreport (a cached
 * call that never carried the context, a summary request, a gateway
 * substituting a number) and it is discarded rather than folded in.
 */
export const CONTEXT_CALIBRATION_SAMPLE_MIN_RATIO = 0.5;
export const CONTEXT_CALIBRATION_SAMPLE_MAX_RATIO = 3;

/** Consecutive misreports that freeze the downward direction. */
export const CONTEXT_CALIBRATION_ANOMALY_FREEZE = 2;

/** Agreeing samples required before the corrected value may move down at all. */
export const CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE = 3;

/** Most one downward step may take off the raw estimate. */
export const CONTEXT_CALIBRATION_DOWNWARD_STEP_MAX = 0.15;

/** How far a sample's scale may sit from the estimate before it stops being a ratio. */
export const CONTEXT_CALIBRATION_SCALE_BAND_MIN = 0.5;
export const CONTEXT_CALIBRATION_SCALE_BAND_MAX = 2;

/** The fixed part of an unanchored residual may not exceed this many tokens. */
export const CONTEXT_CALIBRATION_OVERHEAD_CAP = 32_000;

/** A report this many times the request is a misreport, never a measurement. */
const CONTEXT_CALIBRATION_REAL_MAX_RATIO = 20;

/** The displayed band ignores residuals outside this range. */
const CONTEXT_CALIBRATION_RESIDUAL_MIN = 0.25;
const CONTEXT_CALIBRATION_RESIDUAL_MAX = 4;

/** A sample counts as agreeing with a downward move when it reads this much high. */
const CONTEXT_CALIBRATION_DOWNWARD_EVIDENCE = 0.02;

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
  /** Samples whose scale allowed the ratio form to be used. */
  unanchoredScaleSamples: number;
  unanchoredRatio: number;
  overheadTokens: number;
  residualSamples: number;
  residualLowRatio: number;
  residualHighRatio: number;
  /** Consecutive misreports currently seen. */
  anomalies: number;
  /** True while misreports keep the downward direction frozen. */
  frozen: boolean;
  /** Consecutive samples that said the estimate reads high. */
  downwardStreak: number;
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

type UnanchoredSample = { estimate: number; realTotal: number };

/**
 * Two rolling series, one per error above. Kept apart on purpose: a session
 * that has been compacted has both, and mixing them would apply the system
 * overhead twice on an anchored projection.
 */
export class ContextEstimateCalibration {
  private readonly trailingRatios: number[] = [];
  private readonly unanchored: UnanchoredSample[] = [];
  /** `real / predicted` per usable observation; the displayed band. */
  private readonly residuals: number[] = [];
  /** Consecutive misreports. */
  private anomalies = 0;
  /** Consecutive samples that said the estimate reads high. */
  private downwardStreak = 0;
  /** The last value `correct()` returned, for the per-step cap. */
  private lastCorrected: number | null = null;

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
    const predicted = usageTokens + estimatedTrailing * this.trailingRatio();
    this.recordResidual(predicted, realTotal);
    this.recordDownwardEvidence(predicted, realTotal);
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
    const predicted = this.correctUnanchored(estimate);
    this.recordResidual(predicted, realTotal);
    this.recordDownwardEvidence(predicted, realTotal);
    this.push(this.unanchored, { estimate, realTotal });
  }

  /**
   * Correct one raw estimate. Returns the raw value until its series has enough
   * observations, so a fresh session behaves exactly as it did before.
   */
  correct(raw: ContextCalibration): number {
    const rawTokens = Math.max(0, Math.round(raw.tokens));
    const anchored =
      raw.lastUsageIndex !== null && usableNumber(raw.usageTokens);
    const corrected = anchored
      ? // The anchored part is the provider's own number for the prefix and
        // already contains the system/tool overhead of that request, so only
        // the guessed tail is scaled — the unanchored residual must not be
        // added here.
        raw.usageTokens + Math.max(0, raw.trailingTokens) * this.trailingRatio()
      : this.correctUnanchored(rawTokens);
    const value = this.clampCorrection(corrected, rawTokens);
    this.lastCorrected = value;
    return value;
  }

  /** The per-character bias currently believed, or 1 before there is evidence. */
  trailingRatio(): number {
    if (this.trailingRatios.length < CONTEXT_CALIBRATION_MIN_SAMPLES) return 1;
    return median(this.trailingRatios);
  }

  /**
   * The residual ratio currently believed at the estimate's own scale, or
   * `null` when no sample was taken at a comparable scale. Scale-free by
   * construction: only in-band samples reach it.
   */
  unanchoredRatio(atTokens: number): number | null {
    const inBand = this.inBandSamples(atTokens);
    if (inBand.length < CONTEXT_CALIBRATION_MIN_SAMPLES) return null;
    return median(inBand.map((sample) => sample.realTotal / sample.estimate));
  }

  /**
   * The fixed part of the residual — the system/tool overhead a projection
   * without an anchor is missing — capped so it stays an overhead, or 0 before
   * there is evidence.
   */
  overheadTokens(): number {
    if (this.unanchored.length < CONTEXT_CALIBRATION_MIN_SAMPLES) return 0;
    const overheads = this.unanchored.map((sample) =>
      Math.max(0, sample.realTotal - sample.estimate),
    );
    return Math.min(
      CONTEXT_CALIBRATION_OVERHEAD_CAP,
      median(overheads),
    );
  }

  /** What the last `correct()` did, for logging and for tests. */
  view(rawTokens: number, correctedTokens: number): CalibrationView {
    const band = this.band();
    return {
      anchoredSamples: this.trailingRatios.length,
      trailingRatio: this.trailingRatio(),
      unanchoredSamples: this.unanchored.length,
      unanchoredScaleSamples: this.inBandSamples(rawTokens).length,
      unanchoredRatio: this.unanchoredRatio(rawTokens) ?? 0,
      overheadTokens: this.overheadTokens(),
      residualSamples: band.samples,
      residualLowRatio: band.lowRatio,
      residualHighRatio: band.highRatio,
      anomalies: this.anomalies,
      frozen: this.frozen(),
      downwardStreak: this.downwardStreak,
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

  /** True while consecutive misreports keep the downward direction frozen. */
  frozen(): boolean {
    return this.anomalies >= CONTEXT_CALIBRATION_ANOMALY_FREEZE;
  }

  /** An unanchored correction: ratio in band, fixed overhead otherwise. */
  private correctUnanchored(rawTokens: number): number {
    if (rawTokens <= 0) return Math.max(0, rawTokens);
    const ratio = this.unanchoredRatio(rawTokens);
    if (ratio !== null) return rawTokens * ratio;
    const overhead = this.overheadTokens();
    return overhead > 0 ? rawTokens + overhead : rawTokens;
  }

  /** Samples taken at a scale comparable to `atTokens`. */
  private inBandSamples(atTokens: number): UnanchoredSample[] {
    if (!usableNumber(atTokens)) return [];
    return this.unanchored.filter(
      (sample) =>
        sample.estimate >= atTokens * CONTEXT_CALIBRATION_SCALE_BAND_MIN &&
        sample.estimate <= atTokens * CONTEXT_CALIBRATION_SCALE_BAND_MAX,
    );
  }

  private recordResidual(predicted: number, realTotal: number): void {
    if (!usableNumber(predicted) || !usableNumber(realTotal)) return;
    const ratio = realTotal / predicted;
    if (!Number.isFinite(ratio)) return;
    // A report this far from the prediction is a misreport. Counting it keeps
    // the downward direction frozen until a usable report arrives; discarding
    // it keeps the series honest. Anomalies never move the value up either:
    // an unusable report is not evidence in either direction.
    if (
      ratio < CONTEXT_CALIBRATION_SAMPLE_MIN_RATIO ||
      ratio > CONTEXT_CALIBRATION_SAMPLE_MAX_RATIO
    ) {
      this.anomalies += 1;
      return;
    }
    this.anomalies = 0;
    if (
      ratio < CONTEXT_CALIBRATION_RESIDUAL_MIN ||
      ratio > CONTEXT_CALIBRATION_RESIDUAL_MAX
    ) {
      return;
    }
    this.push(this.residuals, ratio);
  }

  /** Does this sample say the estimate reads high enough to justify a step down? */
  private recordDownwardEvidence(predicted: number, realTotal: number): void {
    if (!usableNumber(predicted) || !usableNumber(realTotal)) return;
    if (realTotal < predicted * (1 - CONTEXT_CALIBRATION_DOWNWARD_EVIDENCE)) {
      this.downwardStreak += 1;
      return;
    }
    this.downwardStreak = 0;
  }

  private push<T>(series: T[], value: T): void {
    series.push(value);
    if (series.length > CONTEXT_CALIBRATION_WINDOW) series.shift();
  }

  private clampCorrection(corrected: number, rawTokens: number): number {
    if (!Number.isFinite(corrected)) return rawTokens;
    // A raw estimate of zero carries no scale to clamp against; the correction
    // is then whatever was measured, never negative.
    if (rawTokens <= 0) return Math.max(0, Math.round(corrected));
    const value = clamp(
      corrected,
      rawTokens * CONTEXT_CALIBRATION_FACTOR_MIN,
      rawTokens * CONTEXT_CALIBRATION_FACTOR_MAX,
    );
    if (value >= rawTokens) return Math.round(value);
    // A downward move needs corroboration and may not jump.
    if (!this.downwardAllowed()) return rawTokens;
    const stepFloor =
      this.lastCorrected === null
        ? value
        : this.lastCorrected * (1 - CONTEXT_CALIBRATION_DOWNWARD_STEP_MAX);
    return Math.round(Math.max(value, stepFloor));
  }

  private downwardAllowed(): boolean {
    return (
      !this.frozen() &&
      this.downwardStreak >= CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE
    );
  }
}
