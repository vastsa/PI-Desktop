import { useTranslation } from "react-i18next";
import type { ConfigSyncForm } from "../../features/settings/config-sync-form";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Button, Field, PasswordInput } from "../ui";
import { IconTrash } from "../icons";
import { SettingsDisclosure } from "./SettingsDisclosure";

export function ConfigSyncVaultSettings({ form, locked, disabled, onChange, onChangePassword, onDisconnect }: {
  form: ConfigSyncForm;
  locked: boolean;
  disabled: boolean;
  onChange: <K extends keyof ConfigSyncForm>(key: K, value: ConfigSyncForm[K]) => void;
  onChangePassword: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsCard>
      <SettingsDisclosure title={t("settings.configSync.maintenanceTitle")}>
        {!locked ? (
          <>
            <p className="settings-config-sync-note">{t("settings.configSync.changePasswordDescription")}</p>
            <div className="settings-config-sync-form">
              {(["currentBackupPassword", "newBackupPassword"] as const).map((key) => (
                <Field key={key} label={t(`settings.configSync.${key}`)}>
                  <PasswordInput value={form[key]} onChange={(event) => onChange(key, event.target.value)}
                    aria-label={t(`settings.configSync.${key}`)}
                    autoComplete={key === "currentBackupPassword" ? "current-password" : "new-password"}
                    showLabel={t("settings.configSync.showPassword")} hideLabel={t("settings.configSync.hidePassword")}
                    disabled={disabled} />
                </Field>
              ))}
            </div>
            <div className="settings-config-sync-form-actions">
              <Button variant="secondary" onClick={onChangePassword}
                disabled={disabled || !form.currentBackupPassword || !form.newBackupPassword}>
                {t("settings.configSync.changePassword")}
              </Button>
            </div>
          </>
        ) : null}
        <SettingsRow title={t("settings.configSync.disconnectTitle")}
          description={t("settings.configSync.disconnectDescription")}>
          <Button variant="secondary" onClick={() => {
            if (window.confirm(t("settings.configSync.disconnectConfirm"))) onDisconnect();
          }} disabled={disabled}>
            <IconTrash size={14} />
            {t("settings.configSync.disconnect")}
          </Button>
        </SettingsRow>
      </SettingsDisclosure>
    </SettingsCard>
  );
}
