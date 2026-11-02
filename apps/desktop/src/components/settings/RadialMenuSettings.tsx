/**
 * Settings → General → Radial context menu.
 *
 * The ring is opt-in, and each direction is a user choice: the vocabulary is
 * fixed to actions the empty transcript background can actually perform, so a
 * saved value never names an action the surface cannot run. `none` empties a
 * direction instead of forcing four.
 */
import { useTranslation } from "react-i18next";
import {
  RADIAL_MENU_ACTIONS,
  RADIAL_MENU_DIRECTIONS,
  type AppSettings,
  type RadialMenuAction,
  type RadialMenuPreferences,
} from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import {
  RADIAL_MENU_ACTION_LABEL_KEYS,
  RADIAL_MENU_DIRECTION_LABEL_KEYS,
  resolveRadialMenu,
} from "../../lib/radial-menu";

export function RadialMenuSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const radial = resolveRadialMenu(settings);
  const save = (patch: Partial<RadialMenuPreferences>) =>
    void saveSettings({ radialMenu: { ...settings.radialMenu, ...patch } });
  const actionOptions = RADIAL_MENU_ACTIONS.map((action) => ({
    id: action,
    label: t(RADIAL_MENU_ACTION_LABEL_KEYS[action]),
  }));
  return (
    <SettingsCard
      title={t("settings.radialMenu")}
      description={t("settings.radialMenuDesc")}
    >
      <SettingsRow
        title={t("settings.radialMenuEnable")}
        description={t("settings.radialMenuEnableDesc")}
      >
        <SettingsToggle
          checked={radial.enabled}
          label={t("settings.radialMenuEnable")}
          onChange={() => save({ enabled: !radial.enabled })}
        />
      </SettingsRow>
      {RADIAL_MENU_DIRECTIONS.map((direction) => (
        <SettingsRow
          key={direction}
          title={t(RADIAL_MENU_DIRECTION_LABEL_KEYS[direction])}
        >
          <SettingsMenuSelect
            label={t(RADIAL_MENU_DIRECTION_LABEL_KEYS[direction])}
            value={radial.slots[direction]}
            options={actionOptions}
            disabled={!radial.enabled}
            onChange={(id) =>
              save({ [direction]: id as RadialMenuAction })
            }
          />
        </SettingsRow>
      ))}
    </SettingsCard>
  );
}
