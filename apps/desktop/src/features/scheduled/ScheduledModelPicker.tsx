import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { imageGenerationBindings, modelIdsMatch } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { composerModelDisplayName, composerModelsForProvider } from "../../lib/composer-models";
import { ComposerModelPicker } from "../chat/composer/ComposerModelPicker";
import { useComposerModelMenu } from "../chat/composer/hooks/useComposerModelMenu";
import { thinkingLevelForProvider, thinkingProviderForModel } from "../chat/composer/model";
import type { ScheduledModelSelection } from "./ScheduledExecutionSettings";

/** The same Composer view/controller, with a task-draft persistence callback. */
export function ScheduledModelPicker({ value, disabled, onChange }: {
  value: ScheduledModelSelection;
  disabled: boolean;
  onChange: (selection: ScheduledModelSelection) => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore(s => s.providers);
  const providerModels = useAppStore(s => s.providerModels);
  const settings = useAppStore(s => s.settings);
  const provider = providers.find(p => p.id === value.providerId);
  const images = useMemo(() => imageGenerationBindings(settings?.imageGenerationModels,
    settings?.imageGeneration), [settings?.imageGenerationModels, settings?.imageGeneration]);
  const selected = provider && composerModelsForProvider(provider, providerModels[provider.id], images)
    .find(model => modelIdsMatch(model.modelId, value.modelId ?? ""));
  const thinkingProvider = thinkingProviderForModel(provider, value.modelId,
    provider ? providerModels[provider.id] : undefined);
  const thinkingLevel = thinkingLevelForProvider(thinkingProvider, value.thinkingLevel ?? "off");
  const controller = useComposerModelMenu({
    mode: "agent", activeSessionId: null, provider, modelId: value.modelId,
    thinkingProvider, thinkingLevel, controlsBlocked: disabled,
    configureActiveSession: async configuration => {
      onChange({providerId: configuration.providerId ?? value.providerId,
        modelId: configuration.modelId ?? value.modelId,
        thinkingLevel: configuration.thinkingLevel});
    },
  });
  const label = selected && provider?.enabled
    ? composerModelDisplayName(provider, selected.modelId, selected.displayName)
    : value.providerId && value.modelId
      ? t("scheduled.unavailableModel", {provider: value.providerId, model: value.modelId})
      : t("settings.defaultModel");
  return <ComposerModelPicker t={t} controller={controller} modelLabel={label}
    thinkingLabel={thinkingLevel} thinkingLevel={thinkingLevel}
    selectedProviderId={value.providerId} selectedModelId={value.modelId}
    controlsBlocked={disabled} onCloseOtherMenus={() => {}}
    rootActions={value.providerId ? <button type="button" className="composer-plus-item"
      role="menuitem" disabled={disabled} onClick={() => {onChange({}); controller.setOpen(false);}}>
      {t("settings.defaultModel")}
    </button> : undefined} />;
}
