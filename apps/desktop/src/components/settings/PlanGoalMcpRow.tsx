import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

export function PlanGoalMcpRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = settings.allowMcpInPlanGoal === true;
  return (
    <SettingsRow
      title={t("settings.allowMcpInPlanGoal")}
      description={t("settings.allowMcpInPlanGoalDesc")}
    >
      <SettingsToggle
        checked={enabled}
        label={t("settings.allowMcpInPlanGoal")}
        onChange={() => void saveSettings({ allowMcpInPlanGoal: !enabled })}
      />
    </SettingsRow>
  );
}
