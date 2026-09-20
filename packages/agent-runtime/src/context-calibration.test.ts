import { describe, expect, it } from "vitest";
import {
  CONTEXT_CALIBRATION_FACTOR_MAX,
  CONTEXT_CALIBRATION_MIN_SAMPLES,
  CONTEXT_CALIBRATION_RATIO_MAX,
  CONTEXT_CALIBRATION_WINDOW,
  ContextEstimateCalibration,
  type ContextCalibration,
} from "./context-calibration.js";

/** A projection with no usage left: the estimator guessed at every message. */
function unanchored(tokens: number): ContextCalibration {
  return {
    tokens,
    usageTokens: 0,
    trailingTokens: tokens,
    lastUsageIndex: null,
  };
}

/** A projection anchored on a real usage: only the tail was guessed at. */
function anchored(
  usageTokens: number,
  trailingTokens: number,
): ContextCalibration {
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: 4,
  };
}

/** A MessageUsage stand-in is not needed here; this module only sees numbers. */
describe("ContextEstimateCalibration", () => {
  it("returns the raw estimate until a series has enough observations", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES - 1; i++) {
      calibration.recordUnanchored(100_000, 300_000);
      calibration.recordAnchored(200_000, 20_000, 260_000);
    }
    expect(calibration.correct(unanchored(100_000))).toBe(100_000);
    expect(calibration.correct(anchored(200_000, 20_000))).toBe(220_000);
  });

  it("adds the measured overhead back to an unanchored estimate", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      calibration.recordUnanchored(100_000, 180_000);
    }
    expect(calibration.unanchoredOffset()).toBe(80_000);
    expect(calibration.correct(unanchored(100_000))).toBe(180_000);
  });

  it("scales only the guessed tail when an anchor exists", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      // 100k after the anchor estimated at 25k: the estimator's `chars / 4`
      // belief is four times too small for this text.
      calibration.recordAnchored(400_000, 25_000, 500_000);
    }
    expect(calibration.trailingRatio()).toBe(4);
    // The anchor is the provider's own number and is never rewritten.
    expect(calibration.correct(anchored(400_000, 25_000))).toBe(500_000);
  });

  it("keeps the two series apart", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      calibration.recordUnanchored(100_000, 180_000);
    }
    // An anchored projection already carries the system/tool overhead of the
    // previous request; the unanchored offset must not be added on top of it.
    expect(calibration.correct(anchored(500_000, 10_000))).toBe(510_000);

    const other = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      other.recordAnchored(400_000, 25_000, 500_000);
    }
    expect(other.correct(unanchored(100_000))).toBe(100_000);
  });

  it("takes the median, so one wild report cannot move the correction", () => {
    const calibration = new ContextEstimateCalibration();
    calibration.recordUnanchored(100_000, 180_000);
    calibration.recordUnanchored(100_000, 180_000);
    calibration.recordUnanchored(100_000, 900_000);
    expect(calibration.correct(unanchored(100_000))).toBe(180_000);
  });

  it("drops the oldest observation once the window is full", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_WINDOW; i++) {
      calibration.recordUnanchored(100_000, 180_000);
    }
    for (let i = 0; i < CONTEXT_CALIBRATION_WINDOW; i++) {
      calibration.recordUnanchored(100_000, 120_000);
    }
    expect(calibration.correct(unanchored(100_000))).toBe(120_000);
  });

  it("ignores values that cannot be measurements", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      calibration.recordUnanchored(0, 50_000);
      calibration.recordUnanchored(-1, 50_000);
      calibration.recordUnanchored(Number.NaN, 50_000);
      calibration.recordUnanchored(100_000, Number.POSITIVE_INFINITY);
      // A gateway substituting a number: not this request's context.
      calibration.recordUnanchored(100, 100_000_000);
      calibration.recordAnchored(100_000, 0, 200_000);
      calibration.recordAnchored(100_000, 10_000, 90_000);
    }
    expect(calibration.unanchoredOffset()).toBe(0);
    expect(calibration.trailingRatio()).toBe(1);
    expect(calibration.correct(unanchored(100_000))).toBe(100_000);
  });

  it("clamps the calibrated ratio and the corrected total", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      // 100k of real tail against a 1k guess would mean a ratio of 100.
      calibration.recordAnchored(50_000, 1_000, 150_000);
    }
    expect(calibration.trailingRatio()).toBe(CONTEXT_CALIBRATION_RATIO_MAX);
    expect(calibration.correct(anchored(50_000, 1_000))).toBe(54_000);

    const inflated = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      // Inside the sanity band (under 20x) but well outside the correction
      // band, so this exercises the clamp rather than the rejection.
      inflated.recordUnanchored(1_000, 10_000);
    }
    expect(inflated.correct(unanchored(1_000))).toBe(
      1_000 * CONTEXT_CALIBRATION_FACTOR_MAX,
    );
  });

  it("never returns a negative total for an empty projection", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      calibration.recordUnanchored(100_000, 10_000);
    }
    expect(calibration.correct(unanchored(0))).toBe(0);
  });

  it("reports what it believes, for the log and for tests", () => {
    const calibration = new ContextEstimateCalibration();
    calibration.recordUnanchored(100_000, 180_000);
    calibration.recordUnanchored(100_000, 180_000);
    calibration.recordUnanchored(100_000, 180_000);
    calibration.recordAnchored(400_000, 25_000, 500_000);
    const raw = unanchored(100_000);
    const view = calibration.view(100_000, calibration.correct(raw));
    expect(view).toEqual({
      anchoredSamples: 1,
      trailingRatio: 1,
      unanchoredSamples: 3,
      unanchoredOffset: 80_000,
      // Three unanchored observations predicted 100k against a real 180k, then
      // one anchored observation predicted 425k against a real 500k.
      residualSamples: 4,
      residualLowRatio: expect.closeTo(500_000 / 425_000, 5),
      residualHighRatio: 1.8,
      rawTokens: 100_000,
      correctedTokens: 180_000,
    });
  });

  /**
   * The measured band, on a realistic sequence rather than a synthetic one:
   * CJK-heavy trailing text (the estimator's chars/4 constant under-counts it
   * by a factor), where the correction starts wrong and then closes the gap —
   * the band must show both, and must ignore a misreporting gateway.
   */
  it("reports the spread of its own residuals and ignores misreports", () => {
    const calibration = new ContextEstimateCalibration();
    for (let index = 0; index < 4; index += 1) {
      // real trailing 100k against an estimate of 40k: a 2.5x per-character
      // bias, the shape a CJK-heavy session actually produces.
      calibration.recordAnchored(300_000, 40_000, 400_000);
    }
    const band = calibration.band();
    expect(band.samples).toBe(4);
    // The first three observations were predicted with ratio 1, the fourth
    // with the learned 2.5, so the spread is real but narrower than the bias.
    expect(band.highRatio).toBeGreaterThan(band.lowRatio);
    expect(band.highRatio).toBeLessThan(2.5);

    const before = calibration.band();
    calibration.recordUnanchored(10_000, 300_000);
    expect(calibration.band()).toEqual(before);
  });
});

