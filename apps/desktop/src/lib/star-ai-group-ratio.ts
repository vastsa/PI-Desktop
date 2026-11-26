import type { StarAiGroupRatio } from "@pi-desktop/shared";

/** Display only the effective multiplier supplied by the relay for this account. */
export function starAiGroupRatioLabel(ratio: StarAiGroupRatio | undefined, autoLabel: string): string | undefined {
  if (ratio === "auto") return autoLabel;
  if (typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0) return `${ratio}×`;
  return undefined;
}
