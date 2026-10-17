import { useTranslation } from "react-i18next";
import type { ConfigSyncCategorySelection } from "@pi-desktop/shared";
import { Checkbox } from "../ui";
import { SettingsDisclosure } from "./SettingsDisclosure";

const CATEGORIES = [
  ["application", "categoryApplication"],
  ["providers", "categoryProviders"],
  ["mcp", "categoryMcp"],
  ["skills", "categorySkills"],
  ["subagents", "categorySubagents"],
  ["instructions", "categoryInstructions"],
  ["plugins", "categoryPlugins"],
  ["automation", "categoryAutomation"],
  ["memory", "categoryMemory"],
  ["credentials", "categoryCredentials"],
] as const;

export function ConfigSyncScopeFields({ selection, disabled, onChange }: {
  selection: ConfigSyncCategorySelection;
  disabled: boolean;
  onChange: (key: keyof ConfigSyncCategorySelection, value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsDisclosure title={t("settings.configSync.categoriesTitle")}>
      <p className="settings-config-sync-note">{t("settings.configSync.categoriesDescription")}</p>
      <div className="settings-config-sync-categories">
        {CATEGORIES.map(([key, label]) => (
          <Checkbox key={key} className="settings-config-sync-category"
            checked={selection[key]} disabled={disabled}
            onChange={(event) => onChange(key, event.target.checked)}
            label={t(`settings.configSync.${label}`)} />
        ))}
      </div>
      {selection.credentials ? (
        <div className="settings-config-sync-warning" role="note">
          {t("settings.configSync.credentialsWarning")}
        </div>
      ) : null}
    </SettingsDisclosure>
  );
}
