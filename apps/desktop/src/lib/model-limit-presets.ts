/**
 * Preset ladders for the model binding's context-window and max-output
 * fields (Settings → Agent → a model's Advanced sheet, #202). Clicking a
 * preset writes the token count into the numeric input; the input stays
 * hand-editable, and the chip matching the current value highlights.
 */

export type LimitPreset = { label: string; tokens: number };

export const CONTEXT_WINDOW_PRESETS: readonly LimitPreset[] = [
  { label: "128k", tokens: 128_000 },
  { label: "256k", tokens: 256_000 },
  { label: "312k", tokens: 312_000 },
  { label: "500k", tokens: 500_000 },
  { label: "1M", tokens: 1_000_000 },
];

export const MAX_OUTPUT_PRESETS: readonly LimitPreset[] = [
  { label: "4k", tokens: 4_000 },
  { label: "8k", tokens: 8_000 },
  { label: "16k", tokens: 16_000 },
  { label: "32k", tokens: 32_000 },
  { label: "128k", tokens: 128_000 },
];

/** Index of the preset whose token count equals `value`; -1 when none does. */
export function matchPresetIndex(
  presets: readonly LimitPreset[],
  value: number | null | undefined,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return -1;
  }
  return presets.findIndex((preset) => preset.tokens === value);
}
