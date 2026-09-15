import { describe, expect, it } from "vitest";
import {
  AUTO_THINKING_BASELINE,
  effectiveThinkingLevelForSession,
  highestSupportedThinkingLevel,
  initialThinkingLevelForBinding,
  nearestSupportedThinkingLevel,
  publishedThinkingLevels,
  resolveAutoThinkingLevel,
} from "./thinking-levels.js";
import { isThinkingLevelMode } from "./types/sessions.js";

describe("resolveAutoThinkingLevel", () => {
  it("uses medium as the default auto baseline", () => {
    expect(AUTO_THINKING_BASELINE).toBe("medium");
  });

  it("resolves to off when no level is published", () => {
    expect(resolveAutoThinkingLevel("off", undefined)).toBe("off");
    expect(resolveAutoThinkingLevel("off", [])).toBe("off");
    expect(resolveAutoThinkingLevel("medium", undefined)).toBe("off");
  });

  it("keeps the baseline when it is supported", () => {
    expect(resolveAutoThinkingLevel("off", ["off", "low", "high"])).toBe("off");
    expect(resolveAutoThinkingLevel("medium", ["low", "medium", "high"])).toBe("medium");
  });

  it("clamps the baseline onto the nearest supported level", () => {
    expect(resolveAutoThinkingLevel("medium", ["low", "high", "max"])).toBe("high");
    expect(resolveAutoThinkingLevel("max", ["off", "low"])).toBe("low");
  });
});

describe("effectiveThinkingLevelForSession", () => {
  it("resolves the baseline per turn in auto mode", () => {
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "off", thinkingLevelMode: "auto" },
        ["off", "low", "high"],
      ),
    ).toBe("off");
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "high", thinkingLevelMode: "auto" },
        ["off", "low", "high"],
      ),
    ).toBe("high");
  });

  it("keeps the auto off baseline even when off is omitted from the catalog", () => {
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "off", thinkingLevelMode: "auto" },
        ["low", "medium", "high"],
      ),
    ).toBe("off");
  });

  it("resolves to off in auto mode when no level is published", () => {
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "high", thinkingLevelMode: "auto" },
        [],
      ),
    ).toBe("off");
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "high", thinkingLevelMode: "auto" },
        undefined,
      ),
    ).toBe("off");
  });

  it("falls back to the classic clamp without auto mode", () => {
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "medium", thinkingLevelMode: "manual" },
        ["low", "high", "max"],
      ),
    ).toBe("high");
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "medium", thinkingLevelMode: null },
        ["low", "high", "max"],
      ),
    ).toBe("high");
    expect(
      effectiveThinkingLevelForSession(
        { thinkingLevel: "medium" },
        ["low", "high", "max"],
      ),
    ).toBe("high");
  });
});

describe("isThinkingLevelMode", () => {
  it("accepts the two session-layer modes", () => {
    expect(isThinkingLevelMode("auto")).toBe(true);
    expect(isThinkingLevelMode("manual")).toBe(true);
  });

  it("rejects anything that is not a mode", () => {
    expect(isThinkingLevelMode("high")).toBe(false);
    expect(isThinkingLevelMode("Auto")).toBe(false);
    expect(isThinkingLevelMode(null)).toBe(false);
    expect(isThinkingLevelMode(undefined)).toBe(false);
    expect(isThinkingLevelMode(1)).toBe(false);
  });
});

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
