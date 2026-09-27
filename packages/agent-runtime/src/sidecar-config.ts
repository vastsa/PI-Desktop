import type { ThinkingLevel } from "@pi-desktop/shared";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const DEFAULT_REASONING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return typeof value === "string" &&
    THINKING_LEVELS.includes(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : "off";
}

export function normalizeSupportedThinkingLevels(
  value: unknown,
  supportsReasoning: boolean,
): ThinkingLevel[] {
  if (!supportsReasoning) return ["off"];
  if (!Array.isArray(value)) return [...DEFAULT_REASONING_LEVELS];
  const levels = value.filter(
    (level): level is ThinkingLevel =>
      typeof level === "string" &&
      THINKING_LEVELS.includes(level as ThinkingLevel),
  );
  return levels.length > 0 ? [...new Set(levels)] : [...DEFAULT_REASONING_LEVELS];
}
