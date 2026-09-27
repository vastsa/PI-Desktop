import { describe, expect, it } from "vitest";
import {
  normalizeSupportedThinkingLevels,
  normalizeThinkingLevel,
} from "./sidecar-config.js";

describe("sidecar thinking-level boundary", () => {
  it("preserves supported levels from IPC params", () => {
    expect(normalizeThinkingLevel("high")).toBe("high");
    expect(normalizeThinkingLevel("off")).toBe("off");
  });

  it("fails closed to off for malformed or absent params", () => {
    expect(normalizeThinkingLevel(undefined)).toBe("off");
    expect(normalizeThinkingLevel("invalid")).toBe("off");
    expect(normalizeThinkingLevel(3)).toBe("off");
  });

  it("normalizes provider capability metadata at the sidecar boundary", () => {
    expect(normalizeSupportedThinkingLevels(undefined, true)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(normalizeSupportedThinkingLevels(["high", "high", "invalid"], true)).toEqual([
      "high",
    ]);
    expect(normalizeSupportedThinkingLevels(["high"], false)).toEqual(["off"]);
  });
});
