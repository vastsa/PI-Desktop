import { describe, expect, it } from "vitest";
import { isPlaybackSignalActive } from "./playback-monitor.js";

describe("Live playback signal monitor", () => {
  it("treats empty, silent, and non-finite buffers as idle", () => {
    expect(isPlaybackSignalActive(new Float32Array())).toBe(false);
    expect(isPlaybackSignalActive(new Float32Array(32))).toBe(false);
    expect(isPlaybackSignalActive(Float32Array.of(Number.NaN, Number.POSITIVE_INFINITY))).toBe(false);
  });

  it("detects samples above the audible-level threshold", () => {
    expect(isPlaybackSignalActive(Float32Array.of(0.02, -0.02, 0.01, -0.01))).toBe(true);
  });
});
