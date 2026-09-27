import { describe, expect, it } from "vitest";
import {
  highestSupportedThinkingLevel,
  initialThinkingLevelForBinding,
  nearestSupportedThinkingLevel,
  publishedThinkingLevels,
} from "./thinking-levels.js";

describe("highestSupportedThinkingLevel", () => {
  it("returns the highest canonical level regardless of provider ordering", () => {
    expect(highestSupportedThinkingLevel(["high", "off", "low"])).toBe("high");
    expect(highestSupportedThinkingLevel(["max", "off", "xhigh"])).toBe("max");
  });

  it("falls back to off when no supported level is published", () => {
    expect(highestSupportedThinkingLevel(undefined)).toBe("off");
    expect(highestSupportedThinkingLevel([])).toBe("off");
  });
});

describe("nearestSupportedThinkingLevel", () => {
  it("keeps a requested level that is enabled", () => {
    expect(nearestSupportedThinkingLevel("low", ["low", "high", "max"])).toBe("low");
  });

  it("walks up first, then down, then off", () => {
    expect(nearestSupportedThinkingLevel("medium", ["low", "high", "max"])).toBe("high");
    expect(nearestSupportedThinkingLevel("max", ["off", "low"])).toBe("low");
    expect(nearestSupportedThinkingLevel("low", [])).toBe("off");
  });
});

describe("initialThinkingLevelForBinding", () => {
  it("uses the stored default when it is still enabled", () => {
    expect(
      initialThinkingLevelForBinding({
        thinkingLevels: ["low", "high", "max"],
        defaultThinkingLevel: "low",
      }),
    ).toBe("low");
  });

  it("clamps a stale stored default onto the enabled ladder", () => {
    expect(
      initialThinkingLevelForBinding({
        thinkingLevels: ["high", "max"],
        defaultThinkingLevel: "low",
      }),
    ).toBe("high");
  });

  it("falls back to the strongest enabled level when no default is stored", () => {
    expect(
      initialThinkingLevelForBinding({
        thinkingLevels: ["low", "high", "max"],
        defaultThinkingLevel: null,
      }),
    ).toBe("max");
    expect(initialThinkingLevelForBinding(undefined, ["low", "high"])).toBe("high");
  });

  it("honors an explicit off default and empty bindings", () => {
    expect(
      initialThinkingLevelForBinding({
        thinkingLevels: ["off", "low"],
        defaultThinkingLevel: "off",
      }),
    ).toBe("off");
    expect(
      initialThinkingLevelForBinding({
        thinkingLevels: [],
        defaultThinkingLevel: null,
      }),
    ).toBe("off");
  });
});

describe("publishedThinkingLevels", () => {
  it("returns the published levels in canonical order", () => {
    expect(publishedThinkingLevels({
      reasoning: true,
      supportedThinkingLevels: ["high", "off", "low"],
    })).toEqual(["off", "low", "high"]);
  });

  it("derives levels from a published level map when no list exists", () => {
    expect(publishedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { max: "max", off: "none", minimal: null },
    })).toEqual(["off", "max"]);
  });

  it("treats an explicitly non-reasoning model as having no enableable level", () => {
    // A capability projection spells this as ["off"]; ADR 0114 wants an empty
    // list so the settings dialog offers no chip at all.
    expect(publishedThinkingLevels({
      reasoning: false,
      supportedThinkingLevels: ["off"],
    })).toEqual([]);
  });

  it("falls back to low/medium/high only for a reasoning model with no level data", () => {
    expect(publishedThinkingLevels({ reasoning: true })).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(publishedThinkingLevels({ reasoning: false })).toEqual([]);
    expect(publishedThinkingLevels(undefined)).toEqual([]);
  });
});
