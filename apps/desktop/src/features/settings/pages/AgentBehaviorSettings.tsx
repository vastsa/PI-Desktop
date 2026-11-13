/**
 * Agent behavior destination (D684): what a new conversation starts with, and
 * what the agent is allowed to do while it runs.
 *
 * Session defaults and Execution replace the old Defaults card, which had
 * grown into the page's catch-all: it mixed these decisions with transcript
 * presentation and composer input, which are now the Conversation
 * destination.
 */
import type { AppSettings, GlobalPermissionMode } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SegmentedControl, SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { ComputerUseSettings } from "../computer-use/ComputerUseSettings";
import { GoalBudgetSettingsRow } from "../../modes/GoalBudgetSettingsRow";
import { ProviderRetrySettingsRows } from "../provider-retry-settings";
import { CommandShellRow, SettingsCard, SettingsRow } from "../primitives";

export function AgentBehaviorSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard
        title={t("settings.sessionDefaults")}
        caption={t("settings.sessionDefaultsCaption")}
      >
        <SettingsRow title={t("settings.mode")} description={t("settings.modeDesc")}>
          <SegmentedControl
            value={settings.defaultMode ?? "agent"}
            onChange={(value) => void saveSettings({ defaultMode: value })}
            options={[
              { value: "agent", label: t("settings.modeAgent") },
              { value: "plan", label: t("settings.modePlan") },
              { value: "goal", label: t("settings.modeGoal") },
            ]}
            label={t("settings.mode")}
            role="group"
          />
        </SettingsRow>
        <GoalBudgetSettingsRow settings={settings} saveSettings={saveSettings} />
        <SettingsRow
          title={t("settings.permissionMode")}
          description={t("settings.permissionModeDesc")}
        >
          <SettingsMenuSelect
            className="settings-permission-select"
            label={t("settings.permissionMode")}
            value={settings.defaultPermissionMode ?? "ask"}
            onChange={(mode) =>
              void saveSettings({
                defaultPermissionMode: mode as GlobalPermissionMode,
              })
            }
            options={[
              { id: "ask", label: t("settings.permissionModeAsk") },
              {
                id: "accept-edits",
                label: t("settings.permissionModeAcceptEdits"),
              },
              { id: "auto", label: t("settings.permissionModeAuto") },
            ]}
          />
        </SettingsRow>
        <CommandShellRow settings={settings} saveSettings={saveSettings} />
      </SettingsCard>

      <SettingsCard title={t("settings.execution")}>
        <ProviderRetrySettingsRows settings={settings} saveSettings={saveSettings} />
        <SettingsRow
          title={t("settings.scheduledTasks")}
          description={t("settings.scheduledTasksDesc")}
        >
          <SettingsToggle
            checked={settings.scheduledTasksEnabled !== false}
            label={t("settings.scheduledTasks")}
            onChange={() => void saveSettings({
              scheduledTasksEnabled: settings.scheduledTasksEnabled === false,
            })}
          />
        </SettingsRow>
      </SettingsCard>

      <ComputerUseSettings t={t} settings={settings} saveSettings={saveSettings} />
    </div>
  );
}
