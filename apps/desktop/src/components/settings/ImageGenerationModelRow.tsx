import { useTranslation } from "react-i18next";
import type { AppSettings, ProviderPublic } from "@pi-desktop/shared";

export function ImageGenerationModelRow({ settings, providers }: {
  settings: AppSettings;
  providers: ProviderPublic[];
}) {
  const { t } = useTranslation();
  const binding = settings.imageGeneration;
  const provider = providers.find((entry) => entry.id === binding?.providerId);
  const valid = provider?.enabled && provider.authKind !== "oauth" &&
    !!provider.baseUrl && (provider.hasSecret || provider.authKind === "none") &&
    provider.models.some((model) => model.id === binding?.modelId);

  return (
    <div className="settings-row model-default-row model-image-row">
      <div className="settings-row-copy model-default-copy">
        <div className="settings-row-title model-default-label">{t("settings.imageModel")}</div>
        <div className="settings-row-detail model-default-value">
          {valid && binding ? (
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
    </div>
  );
}
