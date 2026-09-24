import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  FONT_SCALE_PRESETS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  FONT_SCALE_STEP,
  resolveFontScale,
} from "@pi-desktop/shared";
import { SegmentedControl } from "../ui";
import { SettingsRow } from "../../features/settings/primitives";

const PRESETS = [
  { scale: FONT_SCALE_PRESETS.small, key: "settings.fontSizeSmall" },
  { scale: FONT_SCALE_PRESETS.default, key: "settings.fontSizeDefault" },
  { scale: FONT_SCALE_PRESETS.large, key: "settings.fontSizeLarge" },
  { scale: FONT_SCALE_PRESETS.xl, key: "settings.fontSizeXl" },
] as const;

/**
 * Global type scale (Settings → General → Appearance). Presets plus a
 * percentage slider persist as `AppSettings.fontScale` and multiply the
 * `--text-*` ramp on `:root`. Window zoom is unchanged.
 */
export function FontSizeRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const current = resolveFontScale(settings);

  const commit = (next: number) => {
    const scale = resolveFontScale({ fontScale: next });
    if (scale === current) return;
    void saveSettings({ fontScale: scale }).catch(() => undefined);
  };

  return (
    <SettingsRow
      title={t("settings.fontSize")}
      description={t("settings.fontSizeDesc")}
    >
      <div className="settings-font-size">
        <SegmentedControl
          value={String(current)}
          onChange={(value) => commit(Number(value))}
          options={PRESETS.map((preset) => ({ value: String(preset.scale), label: t(preset.key) }))}
          label={t("settings.fontSize")}
        />
        <div className="settings-font-size-slider">
          <input
            type="range"
            min={MIN_FONT_SCALE}
            max={MAX_FONT_SCALE}
            step={FONT_SCALE_STEP}
            value={current}
            aria-label={t("settings.fontSizeScale")}
            aria-valuetext={t("settings.fontSizePercent", {
              value: Math.round(current * 100),
            })}
            onChange={(event) => commit(Number(event.target.value))}
          />
          <span className="settings-font-size-percent">
            {t("settings.fontSizePercent", {
              value: Math.round(current * 100),
            })}
          </span>
        </div>
      </div>
    </SettingsRow>
  );
}
