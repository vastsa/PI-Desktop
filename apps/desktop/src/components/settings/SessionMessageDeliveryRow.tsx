import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { SettingsToggle } from "../ui";
import { SettingsRow } from "../../features/settings/primitives";

export function SessionMessageDeliveryRow({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = settings.sessionMessagesInCurrentTurn === true;
  return (
    <SettingsRow title={t("settings.sessionMessagesInCurrentTurn")} description={t("settings.sessionMessagesInCurrentTurnDesc")}>
      <SettingsToggle
        checked={enabled}
        label={t("settings.sessionMessagesInCurrentTurn")}
        onChange={() => void saveSettings({ sessionMessagesInCurrentTurn: !enabled })}
      />
    </SettingsRow>
  );
}
