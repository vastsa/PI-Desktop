/**
 * System destination (D684): the machine-level settings that used to be
 * appended to General — outbound network, where application data lives, sleep
 * blockers, and what the window's close button does.
 *
 * They share one property: they are about this installation rather than about
 * the product's look or the agent's behavior.
 */
import type { AppSettings, ShortcutPlatform } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SettingsToggle } from "../../../components/ui";
import { NetworkProxySection } from "../../../components/settings/NetworkProxySection";
import { CloseBehaviorSection } from "../developer-sections";
import { SettingsCard, SettingsRow } from "../primitives";
import { StorageSettingsSection } from "../StorageSettingsSection";

export function SystemSettings({
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
      <NetworkProxySection settings={settings} saveSettings={saveSettings} />

      <StorageSettingsSection />

      <SettingsCard title={t("settings.power")}>
        <SettingsRow
          title={t("settings.keepAwakeWhileRunning")}
          description={t("settings.keepAwakeWhileRunningDesc")}
        >
          <SettingsToggle
            checked={settings.keepAwakeWhileRunning === true}
            label={t("settings.keepAwakeWhileRunning")}
            onChange={() => void saveSettings({
              keepAwakeWhileRunning: settings.keepAwakeWhileRunning !== true,
            })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.preventScreenSleep")}
          description={t("settings.preventScreenSleepDesc")}
        >
          <SettingsToggle
            checked={settings.preventScreenSleep === true}
            label={t("settings.preventScreenSleep")}
            onChange={() => void saveSettings({ preventScreenSleep: !settings.preventScreenSleep })}
          />
        </SettingsRow>
      </SettingsCard>

      {platform !== "darwin" && <CloseBehaviorSection />}
    </div>
  );
}
