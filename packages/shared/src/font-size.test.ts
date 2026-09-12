import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_PRESETS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  fontScaleFromLegacyFontSize,
  normalizeFontScale,
  resolveFontScale,
} from "./font-size.js";

describe("font scale", () => {
  it("defaults absent and invalid values to 1", () => {
    expect(normalizeFontScale(undefined)).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(null)).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale("1.2")).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(Number.NaN)).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_FONT_SCALE,
    );
  });

  it("clamps and snaps to the 0.025 grid", () => {
    expect(normalizeFontScale(MIN_FONT_SCALE)).toBe(0.8);
    expect(normalizeFontScale(MAX_FONT_SCALE)).toBe(1.5);
    expect(normalizeFontScale(0.5)).toBe(0.8);
    expect(normalizeFontScale(2)).toBe(1.5);
    expect(normalizeFontScale(1.12)).toBe(1.125);
    expect(normalizeFontScale(FONT_SCALE_PRESETS.small)).toBe(0.85);
    expect(normalizeFontScale(FONT_SCALE_PRESETS.large)).toBe(1.15);
    expect(normalizeFontScale(FONT_SCALE_PRESETS.xl)).toBe(1.25);
  });

  it("migrates the unreleased px field as px / 14", () => {
    expect(fontScaleFromLegacyFontSize(14)).toBe(1);
    expect(fontScaleFromLegacyFontSize(12)).toBe(0.85);
    expect(fontScaleFromLegacyFontSize(16)).toBe(1.15);
    expect(fontScaleFromLegacyFontSize(21)).toBe(1.5);
    expect(fontScaleFromLegacyFontSize("14")).toBeUndefined();
  });

  it("prefers fontScale over a leftover fontSize", () => {
    expect(resolveFontScale({ fontScale: 1.25, fontSize: 12 })).toBe(1.25);
    expect(resolveFontScale({ fontSize: 12 })).toBe(0.85);
    expect(resolveFontScale({})).toBe(1);
  });
});
