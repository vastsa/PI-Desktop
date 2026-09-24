import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { resolveThinkingDisplayMode } from "../../lib/turn-process";
import { SettingsRow } from "../../features/settings/primitives";
import { cx } from "../ui";

export function ThinkingDisplayModeRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const current = resolveThinkingDisplayMode(settings.thinkingDisplayMode);
  return (
    <SettingsRow
      title={t("settings.thinkingDisplayMode")}
      description={t("settings.thinkingDisplayModeDesc")}
    >
      <div
        className="settings-segment"
        role="radiogroup"
        aria-label={t("settings.thinkingDisplayMode")}
      >
        {([
          ["detailed", "settings.thinkingDisplayDetailed"],
          ["compact", "settings.thinkingDisplayCompact"],
        ] as const).map(([value, labelKey]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={current === value}
            className={cx(
              "settings-segment-item",
              current === value && "active",
            )}
            onClick={() =>
              void saveSettings({ thinkingDisplayMode: resolveThinkingDisplayMode(value) })
            }
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </SettingsRow>
  );
}
