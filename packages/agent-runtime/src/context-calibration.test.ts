import { describe, expect, it } from "vitest";
import {
  CONTEXT_CALIBRATION_ANOMALY_FREEZE,
  CONTEXT_CALIBRATION_BOUNDARY_GUARD_RATIO,
  CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE,
  CONTEXT_CALIBRATION_FACTOR_MIN,
  CONTEXT_CALIBRATION_FACTOR_MAX,
  CONTEXT_CALIBRATION_MIN_SAMPLES,
  CONTEXT_CALIBRATION_OVERHEAD_CAP,
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

/** One CJK paragraph, so the character count is real text and not a constant. */
const CJK_PARAGRAPH =
  "上下文估计的关键在于尾部：估算器只对最后一条用量之后的消息按字符数除以四来猜，" +
  "而中文正文的真实开销接近每字一个词元。连续低报时不能把估计值一路压到危险区间，" +
  "否则压缩会被推迟，请求就会在临界点上失败。无锚点时必须把系统提示与工具结构的固定开销" +
  "和按比例的中文字符偏差分开处理，跨量级的样本不能当作比例系数直接套用。";

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

  it("scales only the guessed tail when an anchor exists", () => {
    const calibration = new ContextEstimateCalibration();
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      calibration.recordAnchored(200_000, 20_000, 260_000);
    }
    expect(calibration.trailingRatio()).toBe(3);
    expect(calibration.correct(anchored(200_000, 10_000))).toBe(230_000);
    expect(calibration.correct(anchored(200_000, 20_000))).toBe(260_000);
  });

  // ① Conservative handling of anomalous usage.
  describe("under-reporting", () => {
    it("cannot be carried below the safety floor by consecutive low reports", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_WINDOW; i++) {
        calibration.recordUnanchored(1_000_000, 600_000);
      }
      const corrected = calibration.correct(unanchored(1_000_000));
      expect(corrected).toBeGreaterThanOrEqual(
        Math.round(1_000_000 * CONTEXT_CALIBRATION_FACTOR_MIN),
      );
      expect(corrected).toBeLessThanOrEqual(1_000_000);
    });

    it("does not move down at all before enough agreeing samples", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE - 1; i++) {
        calibration.recordUnanchored(1_000_000, 600_000);
      }
      expect(calibration.correct(unanchored(1_000_000))).toBe(1_000_000);
      calibration.recordUnanchored(1_000_000, 600_000);
      expect(calibration.correct(unanchored(1_000_000))).toBeLessThan(1_000_000);
    });

    it("moves up as soon as there is evidence", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(1_000_000, 1_400_000);
      }
      expect(calibration.correct(unanchored(1_000_000))).toBe(1_400_000);
    });

    it("freezes the downward direction after consecutive misreports", () => {
      const calibration = new ContextEstimateCalibration();
      // A corroborated downward streak first, so the freeze is what stops it.
      for (let i = 0; i < CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE; i++) {
        calibration.recordUnanchored(1_000_000, 700_000);
      }
      expect(calibration.correct(unanchored(1_000_000))).toBeLessThan(1_000_000);
      for (let i = 0; i < CONTEXT_CALIBRATION_ANOMALY_FREEZE; i++) {
        calibration.recordUnanchored(1_000_000, 200_000);
      }
      expect(calibration.frozen()).toBe(true);
      expect(calibration.correct(unanchored(1_000_000))).toBe(1_000_000);
      // A usable report unfreezes it, and an unusable one never counts as
      // evidence in the other direction either.
      calibration.recordUnanchored(1_000_000, 1_000_000);
      expect(calibration.frozen()).toBe(false);
    });
    it("does not let anomalous reports enter calibration windows", () => {
      const wild = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        wild.recordUnanchored(1_000_000, 4_000_000);
      }
      expect(wild.unanchoredRatio(1_000_000)).toBeNull();
      expect(wild.overheadTokens()).toBe(0);
      expect(wild.correct(unanchored(1_000_000))).toBe(1_000_000);

      const mixed = new ContextEstimateCalibration();
      mixed.recordUnanchored(1_000_000, 100_000);
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES - 1; i++) {
        mixed.recordUnanchored(1_000_000, 700_000);
      }
      expect(mixed.unanchoredRatio(1_000_000)).toBeNull();
      expect(mixed.correct(unanchored(1_000_000))).toBe(1_000_000);

      const anchoredCalibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        anchoredCalibration.recordAnchored(1_000_000, 100_000, 3_500_000);
      }
      expect(anchoredCalibration.trailingRatio()).toBe(1);
      expect(anchoredCalibration.correct(anchored(1_000_000, 100_000))).toBe(
        1_100_000,
      );
    });
  });

  // ② Ratio versus fixed offset: the same residual, used where it belongs.
  describe("scale", () => {
    it("applies a ratio only to an estimate of a comparable scale", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(100_000, 130_000);
      }
      // A 100k sample says nothing proportional about a 1M projection: only
      // the fixed part of the residual is added.
      expect(calibration.unanchoredRatio(1_000_000)).toBeNull();
      expect(calibration.overheadTokens()).toBe(30_000);
      expect(calibration.correct(unanchored(1_000_000))).toBe(1_030_000);

      // Once the projection is observed at its own scale, the ratio applies.
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(1_000_000, 1_300_000);
      }
      expect(calibration.unanchoredRatio(1_000_000)).toBeCloseTo(1.3, 5);
      expect(calibration.correct(unanchored(1_000_000))).toBe(1_300_000);
    });

    it("caps the fixed part so it stays an overhead", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        // A 40k session with a 120k report stays at the 3x sanity boundary,
        // but its absolute residual is far past a system prompt plus schemas.
        calibration.recordUnanchored(40_000, 120_000);
      }
      expect(calibration.overheadTokens()).toBe(
        CONTEXT_CALIBRATION_OVERHEAD_CAP,
      );
    });

    it("keeps a small-context sample from under-correcting a large one forever", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(100_000, 130_000);
      }
      const large = 1_000_000;
      const first = calibration.correct(unanchored(large));
      // Observed at scale, the correction becomes proportional instead of
      // staying at the fixed 30k it measured on the small session.
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(large, 1_400_000);
      }
      const second = calibration.correct(unanchored(large));
      expect(first).toBe(1_030_000);
      expect(second).toBe(1_400_000);
      expect(second).toBeGreaterThan(first);
    });
    it("keeps the downward step cap normalized when raw scale drops", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(1_000_000, 600_000);
      }
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(100_000, 60_000);
      }

      expect(calibration.correct(unanchored(1_000_000))).toBe(850_000);
      const compacted = calibration.correct(unanchored(100_000));
      expect(compacted).toBe(85_000);
      expect(compacted).toBeLessThanOrEqual(
        100_000 * CONTEXT_CALIBRATION_FACTOR_MAX,
      );
    });
  });

  // ③ Real CJK text: the chars/4 tail is the error this series exists for.
  it("corrects a real CJK tail to the measured cost", () => {
    const calibration = new ContextEstimateCalibration();
    const cjkChars = [...CJK_PARAGRAPH].length;
    const estimatedTail = Math.ceil(cjkChars / 4);
    // Measured cost of CJK text in the tokenizers this app talks to: between
    // roughly 0.6 and 1.0 tokens per character.
    const measuredTail = Math.round(cjkChars * 0.9);
    for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
      calibration.recordAnchored(10_000, estimatedTail, 10_000 + measuredTail);
    }
    const ratio = calibration.trailingRatio();
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThanOrEqual(CONTEXT_CALIBRATION_RATIO_MAX);
    const correctedTail =
      calibration.correct(anchored(10_000, estimatedTail)) - 10_000;
    expect(correctedTail).toBeGreaterThanOrEqual(measuredTail * 0.95);
    expect(correctedTail).toBeLessThanOrEqual(measuredTail * 1.05);
  });

  // ④ The compaction boundary: a correction may not carry a session past it.
  describe("compaction boundary", () => {
    it("still compacts a projection inside the guard ratio of the limit", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_WINDOW; i++) {
        // The worst case for the boundary: every report says the estimate
        // reads high, at the projection's own scale.
        calibration.recordUnanchored(950_000, 600_000);
      }
      const hardLimit = 950_000;
      const guarded = Math.round(
        hardLimit * CONTEXT_CALIBRATION_BOUNDARY_GUARD_RATIO,
      );
      expect(calibration.correct(unanchored(guarded))).toBeGreaterThanOrEqual(
        hardLimit,
      );
    });

    it("bounds how far a correction may defer the boundary", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_WINDOW; i++) {
        calibration.recordUnanchored(950_000, 400_000);
      }
      const hardLimit = 950_000;
      const corrected = calibration.correct(unanchored(hardLimit));
      const deficit = hardLimit - corrected;
      expect(deficit).toBeGreaterThanOrEqual(0);
      expect(deficit).toBeLessThanOrEqual(
        Math.round(hardLimit * (1 - CONTEXT_CALIBRATION_FACTOR_MIN)),
      );
    });


    it("caps the correction at the upper band, and rejects a wild report", () => {
      const calibration = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_MIN_SAMPLES; i++) {
        calibration.recordUnanchored(1_000_000, 2_900_000);
      }
      const corrected = calibration.correct(unanchored(1_000_000));
      expect(corrected).toBe(2_900_000);
      expect(corrected).toBeLessThanOrEqual(
        1_000_000 * CONTEXT_CALIBRATION_FACTOR_MAX,
      );

      // Four times what the calibration predicts is a misreport, not a
      // measurement: it moves the value in neither direction.
      const wild = new ContextEstimateCalibration();
      for (let i = 0; i < CONTEXT_CALIBRATION_ANOMALY_FREEZE; i++) {
        wild.recordUnanchored(1_000_000, 4_000_000);
      }
      expect(wild.frozen()).toBe(true);
      expect(wild.correct(unanchored(1_000_000))).toBe(1_000_000);
    });
  });
});
