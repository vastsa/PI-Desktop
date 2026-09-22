import { useTranslation } from "react-i18next";
import {
  imageGenerationBindings,
  modelIdsMatch,
  type AppSettings,
  type ImageGenerationBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { imageGenerationBindingAvailable } from "./image-generation-default";

function imageModelOptionId(binding: ImageGenerationBinding): string {
  return `${binding.providerId}\u0000${binding.modelId}`;
}

export function ImageGenerationModelRow({
  settings,
  providers,
  busy = false,
  onChange,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  busy?: boolean;
  onChange?: (binding: ImageGenerationBinding) => void;
}) {
  const { t } = useTranslation();
  const binding = settings.imageGeneration;
  const candidates = imageGenerationBindings(settings.imageGenerationModels, binding);
  if (!binding || candidates.length === 0) return null;

  const activeCandidate = candidates.find((candidate) =>
    candidate.providerId === binding.providerId &&
    modelIdsMatch(candidate.modelId, binding.modelId),
  );
  const provider = providers.find((entry) => entry.id === binding.providerId);
  // The same availability rule that decides whether this binding may stay the
  // app default, so the row can never claim a pairing the runtime rejects.
  const valid = imageGenerationBindingAvailable(provider, binding.modelId);
  const options = candidates.map((candidate) => {
    const candidateProvider = providers.find((entry) => entry.id === candidate.providerId);
    const available = imageGenerationBindingAvailable(
      candidateProvider,
      candidate.modelId,
    );
    return {
      id: imageModelOptionId(candidate),
      label: `${candidateProvider?.name ?? candidate.providerId} · ${candidate.modelId}`,
      disabled: !available,
    };
  });

  return (
    <div className="settings-row model-default-row model-image-row">
      <div className="settings-row-copy model-default-copy">
        <div className="settings-row-title model-default-label">{t("settings.imageModel")}</div>
        <div className="settings-row-detail model-default-value">
          {valid && provider ? (
            <>
              <span className="model-default-provider">{provider.name}</span>
              <span className="model-default-sep" aria-hidden>·</span>
              <span className="model-default-model font-mono">{binding.modelId}</span>
            </>
          ) : (
            <span className="model-default-empty" role="status">{t("settings.imageModelUnavailable")}</span>
          )}
        </div>
      </div>
      {onChange && candidates.length > 1 ? (
        <SettingsMenuSelect
          className="model-image-selector"
          label={t("settings.imageModel")}
          value={activeCandidate ? imageModelOptionId(activeCandidate) : ""}
          options={options}
          busy={busy}
          onChange={(id) => {
            const next = candidates.find((candidate) => imageModelOptionId(candidate) === id);
            if (next) onChange(next);
          }}
        />
      ) : null}
    </div>
  );
}
