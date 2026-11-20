/**
 * Settings → Appearance → Sidebar modules.
 *
 * One switch per hideable sidebar module, in the order the sidebar renders
 * them. A section's toolbar buttons are nested under it and disabled while the
 * section is off; they keep their stored value, so turning the section back on
 * restores the previous choice. Settings itself has no switch here: hiding it
 * would remove the only visible way back.
 */
import { useTranslation } from "react-i18next";
import {
  SIDEBAR_MODULES,
  sidebarModuleEnabled,
  type AppSettings,
  type SidebarModuleId,
} from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

export function SidebarModulesSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const modules = settings.sidebarModules;
  const toggle = (id: SidebarModuleId) =>
    void saveSettings({
      sidebarModules: { ...modules, [id]: !sidebarModuleEnabled(modules, id) },
    });

  return (
    <SettingsCard title={t("settings.sidebarModules")}>
      {SIDEBAR_MODULES.map((module) => {
        const parent = "parent" in module ? module.parent : undefined;
        const label = t(`settings.sidebarModule.${module.id}`);
        // The Scheduled entry only exists while scheduled tasks are on.
        const unavailable =
          (parent !== undefined && !sidebarModuleEnabled(modules, parent)) ||
          (module.id === "scheduled" && settings.scheduledTasksEnabled === false);
        return (
          <SettingsRow key={module.id} title={label} nested={parent !== undefined}>
            <SettingsToggle
              checked={sidebarModuleEnabled(modules, module.id)}
              label={label}
              disabled={unavailable}
              onChange={() => toggle(module.id)}
            />
          </SettingsRow>
        );
      })}
    </SettingsCard>
  );
}
