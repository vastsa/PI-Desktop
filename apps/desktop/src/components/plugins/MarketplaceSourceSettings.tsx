import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, PluginMarketSource } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Input, Select } from "../ui";

type MarketplaceSourceSettingsProps = {
  settings: AppSettings;
  activeSource: string;
  onSourceRefreshed: (source: string) => void;
};

export function MarketplaceSourceSettings({
  settings,
  activeSource,
  onSourceRefreshed,
}: MarketplaceSourceSettingsProps) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const source: PluginMarketSource = settings.pluginMarketSource ?? "official";
  const [customUrl, setCustomUrl] = useState(settings.pluginMarketCustomUrl ?? "");

  useEffect(() => {
    setCustomUrl(settings.pluginMarketCustomUrl ?? "");
  }, [settings.pluginMarketCustomUrl]);

  const applySource = async (patch: Partial<AppSettings>) => {
    try {
      const nextSettings = { ...settings, ...patch };
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });

      // Keep settings.set free of network waits; refreshing after persistence
      // also makes the marketplace list reflect the newly selected source.
      const meta = await api.marketRefresh(true);
      onSourceRefreshed(meta.sourceUrl ?? "");
      showToast(
        t("plugins.marketRefreshed", {
          count: meta.pluginCount,
          defaultValue: `Marketplace refreshed (${meta.pluginCount} plugins)`,
        }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const commitCustomUrl = () => {
    const next = customUrl.trim();
    if (next === (settings.pluginMarketCustomUrl ?? "")) return;
    void applySource({ pluginMarketCustomUrl: next });
  };

  return (
    <section
      className="plugins-market-settings"
      aria-labelledby="plugins-market-settings-title"
    >
      <div className="plugins-market-settings-head">
        <div className="plugins-market-settings-copy">
          <h2 id="plugins-market-settings-title" className="settings-card-heading">
            {t("settings.marketProviderTitle")}
          </h2>
          <p className="settings-row-desc">
            {t("settings.marketProviderDesc")}
            {source === "mirror" ? ` ${t("settings.marketProviderMirrorHint")}` : null}
          </p>
          {activeSource ? (
            <p className="plugins-market-settings-active">
              {t("settings.marketActiveSource", { url: activeSource })}
            </p>
          ) : null}
        </div>
        <div className="plugins-market-settings-control">
          <Select
            value={source}
            aria-label={t("settings.marketProvider")}
            onChange={(event) =>
              void applySource({
                pluginMarketSource: event.target.value as PluginMarketSource,
              })
            }
          >
            <option value="official">{t("settings.marketProviderOfficial")}</option>
            <option value="mirror">{t("settings.marketProviderMirror")}</option>
            <option value="custom">{t("settings.marketProviderCustom")}</option>
          </Select>
        </div>
      </div>

      {source === "custom" ? (
        <div className="plugins-market-settings-row">
          <div className="plugins-market-settings-copy">
            <div className="settings-row-title">{t("settings.marketCustomUrl")}</div>
            <div className="settings-row-desc">
              {t("settings.marketCustomUrlDesc")}
            </div>
          </div>
          <div className="plugins-market-settings-control">
            <Input
              type="url"
              value={customUrl}
              placeholder={t("settings.marketCustomUrlPlaceholder")}
              aria-label={t("settings.marketCustomUrl")}
              onChange={(event) => setCustomUrl(event.target.value)}
              onBlur={commitCustomUrl}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitCustomUrl();
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
