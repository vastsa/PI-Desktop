import {
  THINKING_LEVELS,
  modelWireIdsEqual,
  type ModelInfo,
  type ProviderPublic,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { thinkingProviderForModel } from "../chat/composer/model";
import { providerThinkingLevels } from "../../lib/session-thinking";

export function reviewThinkingLevels(
  provider: ProviderPublic | undefined,
  modelId: string | undefined,
  catalog: readonly ModelInfo[] | undefined,
): ThinkingLevel[] {
  if (!provider || !modelId) return ["off"];
  const binding = provider.models.find((entry) => modelWireIdsEqual(entry.id, modelId));
  if (binding) {
    return THINKING_LEVELS.filter((level) => level === "off" || binding.thinkingLevels.includes(level));
  }
  const supported = new Set(providerThinkingLevels(thinkingProviderForModel(provider, modelId, catalog)));
  return THINKING_LEVELS.filter((level) => level === "off" || supported.has(level));
}

export function selectedReviewThinkingLevel(
  current: ThinkingLevel | undefined,
  available: readonly ThinkingLevel[],
): ThinkingLevel {
  return current && available.includes(current) ? current : "off";
}
