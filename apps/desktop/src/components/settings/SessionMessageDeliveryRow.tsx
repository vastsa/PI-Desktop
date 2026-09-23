import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { cx } from "../ui";
import { SettingsRow } from "../../features/settings/primitives";

export function SessionMessageDeliveryRow({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = settings.sessionMessagesInCurrentTurn === true;
  return (
    <SettingsRow title={t("settings.sessionMessagesInCurrentTurn")} description={t("settings.sessionMessagesInCurrentTurnDesc")}>
      <button type="button" className={cx("settings-toggle", enabled && "on")}
        role="switch" aria-checked={enabled} aria-label={t("settings.sessionMessagesInCurrentTurn")}
        onClick={() => void saveSettings({ sessionMessagesInCurrentTurn: !enabled })}>
        <span className="settings-toggle-thumb" />
      </button>
    </SettingsRow>
  );
}
