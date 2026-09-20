import { useEffect, useMemo, useState } from "react";
import type { PluginScenicThemesDestinationMeta } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, HelpIcon, cx } from "../ui";

type Props = {
  destination: PluginScenicThemesDestinationMeta;
  selectTheme: (themeId: string) => Promise<void>;
};

const clampBlur = (value: number) => Math.max(0, Math.min(20, Math.round(value)));

/**
 * The host owns every pixel of this destination. Plugins supply only the
 * already validated card metadata and declared backdrop assets.
 */
export function PluginScenicThemesDestination({ destination, selectTheme }: Props) {
  const selectedTheme = useAppStore((state) => state.settings?.theme);
  const showToast = useAppStore((state) => state.showToast);
  const selectedCard = useMemo(
    () => destination.themes.find((theme) => theme.themeId === selectedTheme) ?? destination.themes[0],
    [destination.themes, selectedTheme],
  );
  const [confirmedBlur, setConfirmedBlur] = useState(selectedCard?.blur ?? 6);
  const [draftBlur, setDraftBlur] = useState(selectedCard?.blur ?? 6);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const blur = selectedCard?.blur ?? selectedCard?.blurDefault ?? 6;
    setConfirmedBlur(blur);
    setDraftBlur(blur);
  }, [selectedCard]);

  if (!selectedCard) return null;

  const chooseTheme = async (themeId: string) => {
    try {
      await selectTheme(themeId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const apply = async () => {
    if (saving || draftBlur === confirmedBlur) return;
    setSaving(true);
    try {
      await api.setPluginScenicThemeBlur(destination.pluginId, selectedCard.themeId, draftBlur);
      setConfirmedBlur(draftBlur);
    } catch (error) {
      setDraftBlur(confirmedBlur);
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="plugin-scenic-themes-destination" aria-label={destination.label}>
      <p className="plugin-scenic-themes-description">{destination.description}</p>
      <div className="plugin-scenic-theme-grid">
        {destination.themes.map((theme) => {
          const selected = theme.themeId === selectedTheme;
          return (
            <button
              key={theme.themeId}
              type="button"
              className={cx("plugin-scenic-theme-card", selected && "active")}
              aria-pressed={selected}
              onClick={() => void chooseTheme(theme.themeId)}
            >
              <img src={theme.previewUrl} alt="" />
              <span className="plugin-scenic-theme-card-shade" aria-hidden />
              <span className="plugin-scenic-theme-card-content">
                <span className="plugin-scenic-theme-card-title">{theme.label}</span>
                <span className="plugin-scenic-theme-card-description">{theme.description}</span>
              </span>
              {selected && <span className="plugin-scenic-theme-card-check" aria-hidden>✓</span>}
            </button>
          );
        })}
      </div>
      <div className="plugin-scenic-blur-control">
        <div className="plugin-scenic-blur-copy">
          <span className="plugin-scenic-blur-label">
            Backdrop blur
            <HelpIcon label={`Applies to ${selectedCard.label}`} />
          </span>
        </div>
        <div className="plugin-scenic-blur-actions">
          <label className="sr-only" htmlFor="plugin-scenic-backdrop-blur">Backdrop blur</label>
          <input
            id="plugin-scenic-backdrop-blur"
            type="range"
            min="0"
            max="20"
            step="1"
            value={draftBlur}
            onChange={(event) => setDraftBlur(clampBlur(Number(event.target.value)))}
          />
          <output htmlFor="plugin-scenic-backdrop-blur">{draftBlur}px</output>
          <Button variant="primary" disabled={saving || draftBlur === confirmedBlur} onClick={() => void apply()}>
            {saving ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
    </section>
  );
}
