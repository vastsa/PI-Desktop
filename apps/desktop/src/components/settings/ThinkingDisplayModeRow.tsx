import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { resolveThinkingDisplayMode } from "../../lib/turn-process";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export function ThinkingDisplayModeRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      title={t("settings.thinkingDisplayMode")}
      description={t("settings.thinkingDisplayModeDesc")}
    >
      <SettingsMenuSelect
        label={t("settings.thinkingDisplayMode")}
        value={resolveThinkingDisplayMode(settings.thinkingDisplayMode)}
        options={[
          { id: "detailed", label: t("settings.thinkingDisplayDetailed") },
          { id: "compact", label: t("settings.thinkingDisplayCompact") },
          { id: "auto", label: t("settings.thinkingDisplayAuto") },
        ]}
        onChange={(value) =>
          void saveSettings({ thinkingDisplayMode: resolveThinkingDisplayMode(value) })
        }
      />
    </SettingsRow>
  );
}
