import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { resolveThinkingDisplayMode } from "../../lib/turn-process";
import { SettingsRow } from "../../features/settings/primitives";
import { SegmentedControl } from "../ui";

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
      <SegmentedControl
        value={current}
        onChange={(value) => void saveSettings({ thinkingDisplayMode: resolveThinkingDisplayMode(value) })}
        options={[
          { value: "detailed", label: t("settings.thinkingDisplayDetailed") },
          { value: "compact", label: t("settings.thinkingDisplayCompact") },
        ]}
        label={t("settings.thinkingDisplayMode")}
      />
    </SettingsRow>
  );
}
