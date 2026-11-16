/**
 * Appearance destination (D684): everything that decides how the app looks.
 *
 * The old General destination also carried proxies, disk maintenance, power
 * blockers and the close-button behavior. Those are machine concerns, not
 * looks, and they now live in System — so this page can be read top to bottom
 * as one subject.
 */
import type { AppSettings, ShortcutPlatform } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SettingsToggle } from "../../../components/ui";
import { FontFamilyRow } from "../../../components/settings/FontFamilyRow";
import { FontSizeRow } from "../../../components/settings/FontSizeRow";
import { LanguageRow } from "../../../components/settings/LanguageRow";
import { MacosWindowTranslucencyRow } from "../../../components/settings/MacosWindowTranslucencyRow";
import { RadialMenuSettings } from "../../../components/settings/RadialMenuSettings";
import { StartupAnimationRows } from "../../../components/settings/StartupAnimationRows";
import { ThemeRow } from "../../../components/settings/ThemeRow";
import { SettingsCard, SettingsRow } from "../primitives";

export function AppearanceSettings({
  settings,
  saveSettings,
  platform,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  platform: ShortcutPlatform;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.interface")}>
        <ThemeRow settings={settings} saveSettings={saveSettings} />
        <LanguageRow settings={settings} saveSettings={saveSettings} />
        <FontFamilyRow settings={settings} saveSettings={saveSettings} />
        <FontSizeRow settings={settings} saveSettings={saveSettings} />
        {platform === "darwin" && (
          <MacosWindowTranslucencyRow settings={settings} saveSettings={saveSettings} />
        )}
      </SettingsCard>

      <SettingsCard title={t("settings.sidebar")}>
        <SettingsRow
          title={t("settings.sidebarRunningIndicators")}
          description={t("settings.sidebarRunningIndicatorsDesc")}
        >
          <SettingsToggle
            checked={settings.sidebarRunningIndicators === true}
            label={t("settings.sidebarRunningIndicators")}
            onChange={() => void saveSettings({
              sidebarRunningIndicators: settings.sidebarRunningIndicators !== true,
            })}
          />
        </SettingsRow>
        {/*
          The two sub-switches are gated by the master switch. They keep
          their stored value while disabled, so turning the master back
          on restores the previous choice instead of resetting it.
        */}
        <SettingsRow title={t("settings.sidebarRunningBadge")} nested>
          <SettingsToggle
            checked={settings.sidebarRunningBadge === true}
            label={t("settings.sidebarRunningBadge")}
            disabled={settings.sidebarRunningIndicators !== true}
            onChange={() => void saveSettings({
              sidebarRunningBadge: settings.sidebarRunningBadge !== true,
            })}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.sidebarRunningRail")} nested>
          <SettingsToggle
            checked={settings.sidebarRunningRail === true}
            label={t("settings.sidebarRunningRail")}
            disabled={settings.sidebarRunningIndicators !== true}
            onChange={() => void saveSettings({
              sidebarRunningRail: settings.sidebarRunningRail !== true,
            })}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.sidebarSessionTime")}>
          <SettingsToggle
            checked={settings.sidebarSessionTime === true}
            label={t("settings.sidebarSessionTime")}
            onChange={() => void saveSettings({
              sidebarSessionTime: settings.sidebarSessionTime !== true,
            })}
          />
        </SettingsRow>
      </SettingsCard>

      <RadialMenuSettings settings={settings} saveSettings={saveSettings} />

      <SettingsCard title={t("settings.startup")}>
        <StartupAnimationRows settings={settings} saveSettings={saveSettings} />
      </SettingsCard>
    </div>
  );
}
