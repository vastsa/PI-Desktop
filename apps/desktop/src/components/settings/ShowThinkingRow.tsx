import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { resolveShowThinking } from "../../lib/thinking-visibility";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

export function ShowThinkingRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showThinking = resolveShowThinking(settings);
  return (
    <SettingsRow
      title={t("settings.showThinking")}
      description={t("settings.showThinkingDesc")}
    >
      <SettingsToggle
        checked={showThinking}
        label={t("settings.showThinking")}
        onChange={() => void saveSettings({ showThinking: !showThinking })}
      />
    </SettingsRow>
  );
}
