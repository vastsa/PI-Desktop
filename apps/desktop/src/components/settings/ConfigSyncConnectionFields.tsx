import { useTranslation } from "react-i18next";
import type { ConfigSyncForm } from "../../features/settings/config-sync-form";
import { SettingsRow } from "../../features/settings/primitives";
import { Checkbox, Field, Input, PasswordInput, SettingsToggle } from "../ui";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

type Props = {
  form: ConfigSyncForm;
  configured: boolean;
  locked: boolean;
  disabled: boolean;
  onChange: <K extends keyof ConfigSyncForm>(key: K, value: ConfigSyncForm[K]) => void;
};

export function ConfigSyncConnectionFields({ form, configured, locked, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const textField = (key: "endpoint" | "bucket" | "accessKeyId" | "region" | "prefix" | "deviceLabel") => (
    <Field key={key} label={t(`settings.configSync.${key}`)}>
      <Input value={form[key]} onChange={(event) => onChange(key, event.target.value)}
        placeholder={key === "endpoint" ? t("settings.configSync.endpointPlaceholder") : key === "deviceLabel" ? t("settings.configSync.defaultDevice") : undefined}
        aria-label={t(`settings.configSync.${key}`)}
        autoComplete={key === "endpoint" ? "url" : "off"} disabled={disabled} />
    </Field>
  );
  return (
    <>
      <SettingsRow title={t("settings.configSync.mode")} description={t("settings.configSync.modeHint")}>
        <SettingsMenuSelect label={t("settings.configSync.mode")} value={form.mode} disabled={disabled}
          options={[
            { id: "sync", label: t("settings.configSync.modeSync") },
            { id: "backup", label: t("settings.configSync.modeBackup") },
          ]}
          onChange={(value) => { if (value === "sync" || value === "backup") onChange("mode", value); }} />
      </SettingsRow>
      <div className="settings-config-sync-form">
        {textField("endpoint")}
        {textField("bucket")}
        {textField("accessKeyId")}
        <Field label={t("settings.configSync.secretAccessKey")}
          hint={configured ? t("settings.configSync.secretSavedHint") : undefined}>
          <PasswordInput value={form.secretAccessKey}
            onChange={(event) => onChange("secretAccessKey", event.target.value)}
            aria-label={t("settings.configSync.secretAccessKey")} autoComplete="new-password"
            showLabel={t("settings.configSync.showPassword")} hideLabel={t("settings.configSync.hidePassword")}
            disabled={disabled} />
        </Field>
        {!locked ? (
          <Field label={configured ? t("settings.configSync.backupPasswordUnlock") : t("settings.configSync.backupPassword")}
            hint={configured ? t("settings.configSync.backupPasswordOptional") : t("settings.configSync.backupPasswordHint")}>
            <PasswordInput value={form.backupPassword} onChange={(event) => onChange("backupPassword", event.target.value)}
              aria-label={t("settings.configSync.backupPassword")} autoComplete="new-password"
              showLabel={t("settings.configSync.showPassword")} hideLabel={t("settings.configSync.hidePassword")}
              disabled={disabled} />
          </Field>
        ) : null}
      </div>
      <SettingsRow title={t("settings.configSync.automaticSync")}>
        <SettingsToggle checked={form.automaticSync} onChange={() => onChange("automaticSync", !form.automaticSync)}
          label={t("settings.configSync.automaticSync")} disabled={disabled} />
      </SettingsRow>
      <SettingsDisclosure title={t("settings.configSync.advancedTitle")}>
        <div className="settings-config-sync-form">
          {textField("region")}
          {textField("prefix")}
          {textField("deviceLabel")}
          <Field label={t("settings.configSync.addressing")} hint={t("settings.configSync.addressingHint")}>
            <SettingsMenuSelect fullWidth label={t("settings.configSync.addressing")}
              value={form.pathStyle ? "path" : "virtual"} disabled={disabled}
              options={[
                { id: "path", label: t("settings.configSync.pathStyle") },
                { id: "virtual", label: t("settings.configSync.virtualHosted") },
              ]}
              onChange={(value) => onChange("pathStyle", value === "path")} />
          </Field>
          <Field label={t("settings.configSync.sessionToken")} hint={t("settings.configSync.sessionTokenHint")}>
            <PasswordInput value={form.sessionToken}
              onChange={(event) => onChange("sessionToken", event.target.value)}
              aria-label={t("settings.configSync.sessionToken")} autoComplete="new-password"
              showLabel={t("settings.configSync.showPassword")} hideLabel={t("settings.configSync.hidePassword")}
              disabled={disabled || form.clearSessionToken} />
            {configured ? <Checkbox checked={form.clearSessionToken}
              onChange={(event) => onChange("clearSessionToken", event.target.checked)}
              label={t("settings.configSync.clearSessionToken")} disabled={disabled} /> : null}
          </Field>
        </div>
      </SettingsDisclosure>
    </>
  );
}
