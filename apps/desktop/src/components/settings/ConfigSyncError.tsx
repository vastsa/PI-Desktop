import { useTranslation } from "react-i18next";
import { configSyncErrorKind } from "../../features/settings/config-sync-error";

export function ConfigSyncError({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="settings-config-sync-message error" role="alert">
      <strong>{t("settings.configSync.errorTitle")}</strong>
      <p>{t(`settings.configSync.errors.${configSyncErrorKind(message)}`)}</p>
      <details>
        <summary>{t("settings.configSync.errorDetails")}</summary>
        <pre>{message}</pre>
      </details>
    </div>
  );
}
