import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  FONT_SCALE_PRESETS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  FONT_SCALE_STEP,
  resolveFontScale,
} from "@pi-desktop/shared";
import { cx } from "../ui";

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
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{t("settings.fontSize")}</div>
        <div className="settings-row-desc">{t("settings.fontSizeDesc")}</div>
      </div>
      <div className="settings-row-control">
        <div className="settings-font-size">
          <div
            className="settings-segment"
            role="radiogroup"
            aria-label={t("settings.fontSize")}
          >
            {PRESETS.map((preset) => (
              <button
                key={preset.scale}
                type="button"
                role="radio"
                aria-checked={current === preset.scale}
                className={cx(
                  "settings-segment-item",
                  current === preset.scale && "active",
                )}
                onClick={() => commit(preset.scale)}
              >
                {t(preset.key)}
              </button>
            ))}
          </div>
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
      </div>
    </div>
  );
}
