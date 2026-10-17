import {
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  type ModelInfo,
  isSessionThinkingLevel,
  modelIdsMatch,
  type ProviderPublic,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import type { SessionModelRef } from "./session-model";

export const COMPOSER_MODEL_PREFERENCES_KEY =
  "pi.desktop.composerModelPreferences.v1";
const MAX_CHOICES = 100;
type Choice = Required<SessionModelRef> & {
  thinkingLevel: SessionThinkingLevel;
};

function isChoice(value: unknown): value is Choice {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.providerId === "string" &&
    row.providerId.length > 0 &&
    typeof row.modelId === "string" &&
    row.modelId.length > 0 &&
    isSessionThinkingLevel(row.thinkingLevel)
  );
}

function readChoices(): Choice[] {
  try {
    const raw: unknown = JSON.parse(
      globalThis.localStorage?.getItem(COMPOSER_MODEL_PREFERENCES_KEY) ??
        "null",
    );
    return Array.isArray(raw) ? raw.filter(isChoice).slice(0, MAX_CHOICES) : [];
  } catch {
    // Missing, blocked or corrupt device preferences fall back to Settings.
    return [];
  }
}

/** Only explicit Composer model/reasoning actions call this, never session navigation. */
export function rememberComposerModel(
  choice: SessionModelRef & { thinkingLevel: SessionThinkingLevel },
): void {
  if (!isChoice(choice)) return;
  const choices = readChoices().filter(
    (entry) =>
      entry.providerId !== choice.providerId ||
      !modelIdsMatch(entry.modelId, choice.modelId),
  );
  try {
    globalThis.localStorage?.setItem(
      COMPOSER_MODEL_PREFERENCES_KEY,
      JSON.stringify(
        [
          {
            providerId: choice.providerId,
            modelId: choice.modelId,
            thinkingLevel: choice.thinkingLevel,
          },
          ...choices,
        ].slice(0, MAX_CHOICES),
      ),
    );
  } catch {
    // Optional device preferences must not prevent configuring a session.
  }
}

export function rememberedComposerThinking(
  provider: ProviderPublic | undefined,
  modelId: string | undefined,
  fallbackLevels = provider?.supportedThinkingLevels,
  fallback: SessionThinkingLevel = initialThinkingLevelForBinding(
    provider?.models.find((entry) => modelIdsMatch(entry.id, modelId ?? "")),
    fallbackLevels,
  ),
  catalogSource?: ModelInfo["catalogSource"],
): SessionThinkingLevel {
  const binding = provider?.models.find((entry) =>
    modelIdsMatch(entry.id, modelId ?? ""),
  );
  const choice = readChoices().find(
    (entry) =>
      entry.providerId === provider?.id &&
      modelIdsMatch(entry.modelId, modelId ?? ""),
  );
  if (!choice) return fallback;
  const resolveThinking = catalogSource === "models.dev"
    ? initialThinkingLevelForBinding
    : initialThinkingLevelForUnmatchedModel;
  return resolveThinking(
    { ...binding, defaultThinkingLevel: choice.thinkingLevel },
    fallbackLevels,
  );
}
