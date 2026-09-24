import { describe, it, expect } from "vitest";
import { convertFrames, computeRms } from "../src/pcm-utils.js";

describe("convertFrames", () => {
  it("converts empty array to empty Float32Array", () => {
    const result = convertFrames([]);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(0);
  });

  it("converts Int16 to normalized Float32", () => {
    const frame = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const result = convertFrames([frame]);

    expect(result.length).toBe(5);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(0.5, 2);
    expect(result[2]).toBeCloseTo(-0.5, 2);
    expect(result[3]).toBeCloseTo(1.0, 2);
    expect(result[4]).toBeCloseTo(-1.0, 2);
  });

  it("concatenates multiple frames", () => {
    const frame1 = new Int16Array([100, 200]);
    const frame2 = new Int16Array([300]);
    const result = convertFrames([frame1, frame2]);

    expect(result.length).toBe(3);
    expect(result[0]).toBeCloseTo(100 / 32768, 5);
    expect(result[1]).toBeCloseTo(200 / 32768, 5);
    expect(result[2]).toBeCloseTo(300 / 32768, 5);
  });

  it("handles single empty frame", () => {
    const result = convertFrames([new Int16Array([])]);
    expect(result.length).toBe(0);
  });
});

describe("computeRms", () => {
  it("returns 0 for empty buffer", () => {
    expect(computeRms(new Float32Array([]))).toBe(0);
  });

  it("returns 0 for silent audio", () => {
    expect(computeRms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it("computes correct RMS for known values", () => {
    // RMS of [1, -1, 1, -1] = sqrt(4/4) = 1
    const pcm = new Float32Array([1, -1, 1, -1]);
    expect(computeRms(pcm)).toBeCloseTo(1, 5);
  });

  it("returns value between 0 and 1 for normalized audio", () => {
    const pcm = new Float32Array([0.5, -0.3, 0.1, -0.7]);
    const rms = computeRms(pcm);
    expect(rms).toBeGreaterThan(0);
    expect(rms).toBeLessThanOrEqual(1);
  });
});
