import { useTranslation } from "react-i18next";
import {
  type AppSettings,
  type ImageGenerationBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { sameComposerModelId } from "../../lib/composer-models";
import {
  imageGenerationBindingAvailable,
  imageGenerationPickerCandidates,
} from "./image-generation-default";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

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
  // The picker's options: the candidate list stored in settings is the user's
  // selection (an explicitly cleared list is not resurrected), a missing list
  // falls back to the legacy single binding, and a signed-in vendor account
  // offers the image model it answers with. The settings page validates the
  // user's choice against this same list, so every row shown here is selectable.
  const candidates = imageGenerationPickerCandidates(
    settings.imageGenerationModels,
    binding,
    providers,
  );
  if (candidates.length === 0) return null;

  const activeCandidate = binding
    ? candidates.find((candidate) =>
      candidate.providerId === binding.providerId &&
      sameComposerModelId(candidate.modelId, binding.modelId),
    )
    : undefined;
  const provider = binding
    ? providers.find((entry) => entry.id === binding.providerId)
    : undefined;
  // The same availability rule that decides whether this binding may stay the
  // app default, so the row can never claim a pairing the runtime rejects.
  const valid = !!activeCandidate &&
    imageGenerationBindingAvailable(provider, activeCandidate.modelId);
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
  // Disabled rows are not choices. With none left, the summary stays hidden
  // instead of showing a checked model the user can no longer pick.
  if (!options.some((option) => !option.disabled)) return null;
  const checkedId = valid && activeCandidate ? imageModelOptionId(activeCandidate) : "";

  return (
    <div className="settings-row model-default-row model-image-row">
      <div className="settings-row-copy model-default-copy">
        <div className="settings-row-title model-default-label">{t("settings.imageModel")}</div>
        <div className="settings-row-detail model-default-value">
          {valid && provider && binding ? (
            <>
              <span className="model-default-provider">{provider.name}</span>
              <span className="model-default-sep" aria-hidden>·</span>
              <span className="model-default-model font-mono">{binding.modelId}</span>
            </>
          ) : (
            <span className="model-default-empty" role="status">
              {t(activeCandidate ? "settings.imageModelUnavailable" : "settings.imageModelUnset")}
            </span>
          )}
        </div>
      </div>
      {onChange && (options.filter((option) => !option.disabled).length > 1 || !checkedId) ? (
        <SettingsMenuSelect
          className="model-image-selector"
          label={t("settings.imageModel")}
          value={checkedId}
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
