import { describe, expect, it } from "vitest";
import {
  highestSupportedThinkingLevel,
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  canonicalThinkingLevel,
  isSessionThinkingLevel,
  nearestSupportedThinkingLevel,
  publishedThinkingLevels,
  sessionThinkingMenuLevels,
  bindingDefaultThinkingMenuLevels,
  resolveBindingDefaultThinkingLevel,
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

describe("initialThinkingLevelForUnmatchedModel", () => {
  it("starts unmatched models at off without overriding an explicit default", () => {
    expect(
      initialThinkingLevelForUnmatchedModel({
        thinkingLevels: ["low", "high", "max"],
        defaultThinkingLevel: null,
      }),
    ).toBe("off");
    expect(initialThinkingLevelForUnmatchedModel(undefined, ["low", "high"])).toBe("off");
    expect(
      initialThinkingLevelForUnmatchedModel({
        thinkingLevels: ["low", "high"],
        defaultThinkingLevel: "low",
      }),
    ).toBe("low");
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

describe("session thinking omit", () => {
  it("accepts omit as a session selector without treating it as a capability", () => {
    expect(isSessionThinkingLevel("omit")).toBe(true);
    expect(isSessionThinkingLevel("high")).toBe(true);
    expect(isSessionThinkingLevel("turbo")).toBe(false);
    expect(sessionThinkingMenuLevels(["low", "high"])).toEqual(["omit", "low", "high"]);
    expect(sessionThinkingMenuLevels([])).toEqual(["off"]);
    expect(canonicalThinkingLevel("omit")).toBe("off");
    expect(canonicalThinkingLevel("high")).toBe("high");
  });

  it("offers omit as a Settings default on a reasoning binding", () => {
    expect(bindingDefaultThinkingMenuLevels(["low", "high"])).toEqual(["omit", "low", "high"]);
    expect(bindingDefaultThinkingMenuLevels(["high"])).toEqual(["omit", "high"]);
    expect(bindingDefaultThinkingMenuLevels(["off"])).toEqual(["off"]);
    expect(bindingDefaultThinkingMenuLevels([])).toEqual(["off"]);
    expect(resolveBindingDefaultThinkingLevel("omit", ["low", "high"])).toBe("omit");
    expect(resolveBindingDefaultThinkingLevel("omit", ["off"])).toBe("off");
    expect(resolveBindingDefaultThinkingLevel(null, ["low", "high"])).toBe("low");
    expect(
      initialThinkingLevelForBinding({
        thinkingLevels: ["low", "high"],
        defaultThinkingLevel: "omit",
      }),
    ).toBe("omit");
    expect(
      initialThinkingLevelForBinding({
        thinkingLevels: ["off"],
        defaultThinkingLevel: "omit",
      }),
    ).toBe("off");
  });
});
