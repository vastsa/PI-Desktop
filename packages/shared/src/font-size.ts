/**
 * Global UI type scale (D343 / ADR 0180).
 *
 * Multiplies the `--text-*` ramp (and the fixed `--leading-row`) so every
 * surface stays in proportion. `1` is the product default. Window zoom is
 * independent and still scales chrome.
 */

export const DEFAULT_FONT_SCALE = 1;
export const MIN_FONT_SCALE = 0.8;
export const MAX_FONT_SCALE = 1.5;
export const FONT_SCALE_STEP = 0.025;

/** Named Appearance presets; any step in the min/max range is also valid. */
export const FONT_SCALE_PRESETS = {
  small: 0.85,
  default: 1,
  large: 1.15,
  xl: 1.25,
} as const;

export type FontScalePreset = keyof typeof FONT_SCALE_PRESETS;

/** Snap a raw scale onto the supported step grid. */
export function normalizeFontScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FONT_SCALE;
  }
  const clamped = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
  const snapped = Math.round(clamped / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Number(snapped.toFixed(3));
}

export function isFontScale(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    normalizeFontScale(value) === value
  );
}

/**
 * One-shot read of the unreleased D343 px field (`fontSize` / 14).
 * Returns undefined when the value is not a usable integer px.
 */
export function fontScaleFromLegacyFontSize(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return normalizeFontScale(value / 14);
}

export function resolveFontScale(settings: {
  fontScale?: unknown;
  fontSize?: unknown;
}): number {
  if (settings.fontScale !== undefined) {
    return normalizeFontScale(settings.fontScale);
  }
  return fontScaleFromLegacyFontSize(settings.fontSize) ?? DEFAULT_FONT_SCALE;
}
