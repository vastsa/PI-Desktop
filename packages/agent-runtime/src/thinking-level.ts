import type { ThinkingLevel } from "@pi-desktop/shared";

export type ThinkingCapabilitySet = {
  supportsReasoning: boolean;
  supportedThinkingLevels: readonly ThinkingLevel[];
};

/** Serializable model metadata resolved in Electron main from models.dev or pi-ai. */
export type PiModelConfig = {
  source: "pi" | "models.dev";
  name: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
};

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Apply pi-ai's nearest-supported-level rule without loading the full model
 * catalog into the sidecar runtime path.
 */
export function clampThinkingLevel(
  capabilities: ThinkingCapabilitySet,
  requested: ThinkingLevel,
): ThinkingLevel {
  if (!capabilities.supportsReasoning) return "off";
  const supported = new Set(capabilities.supportedThinkingLevels ?? ["off"]);
  if (supported.has(requested)) return requested;

  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  return "off";
}
