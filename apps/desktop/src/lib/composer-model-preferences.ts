import {
  initialThinkingLevelForBinding,
  isSessionThinkingLevel,
  modelIdsMatch,
  type ProviderPublic,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  inheritedSessionModelBinding,
  type SessionModelRef,
  type SessionModelSettings,
} from "./session-model";

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
): SessionThinkingLevel {
  const binding = provider?.models.find((entry) =>
    modelIdsMatch(entry.id, modelId ?? ""),
  );
  const choice = readChoices().find(
    (entry) =>
      entry.providerId === provider?.id &&
      modelIdsMatch(entry.modelId, modelId ?? ""),
  );
  return initialThinkingLevelForBinding(
    choice
      ? {
          thinkingLevels: binding?.thinkingLevels ?? fallbackLevels ?? [],
          defaultThinkingLevel: choice.thinkingLevel,
        }
      : binding,
    fallbackLevels,
  );
}

/** Draft > last explicit usable choice > Settings. Existing sessions do not call this. */
export function newSessionModelConfiguration({
  draft,
  settings,
  providers,
}: {
  draft?: (SessionModelRef & { thinkingLevel?: SessionThinkingLevel }) | null;
  settings?: SessionModelSettings | null;
  providers: readonly ProviderPublic[];
}): SessionModelRef & { thinkingLevel: SessionThinkingLevel } {
  const last = readChoices()[0];
  const rememberedProvider = providers.find(
    (provider) =>
      provider.id === last?.providerId &&
      provider.enabled &&
      (provider.hasSecret || provider.authKind === "none"),
  );
  const rememberedModel = rememberedProvider?.models.length
    ? rememberedProvider.models.find((entry) =>
        modelIdsMatch(entry.id, last?.modelId ?? ""),
      )?.id
    : rememberedProvider?.defaultModelId &&
        modelIdsMatch(rememberedProvider.defaultModelId, last?.modelId ?? "")
      ? rememberedProvider.defaultModelId
      : undefined;
  const explicitModel =
    draft?.providerId !== undefined || draft?.modelId !== undefined;
  const inherited = inheritedSessionModelBinding({
    draft: explicitModel
      ? draft
      : rememberedModel
        ? {
            providerId: rememberedProvider?.id,
            modelId: rememberedModel,
          }
        : null,
    settings,
    providers,
  });
  const provider = providers.find((entry) => entry.id === inherited.providerId);
  return {
    ...inherited,
    thinkingLevel:
      draft?.thinkingLevel ??
      rememberedComposerThinking(provider, inherited.modelId),
  };
}
