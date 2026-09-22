import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { resolveQueuedPromptAnimation } from "@pi-desktop/shared";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export function QueuedPromptAnimationRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      title={t("settings.queuedPromptAnimation")}
      description={t("settings.queuedPromptAnimationDesc")}
    >
      <SettingsMenuSelect
        label={t("settings.queuedPromptAnimation")}
        value={resolveQueuedPromptAnimation(settings)}
        options={[
          { id: "off", label: t("settings.queuedPromptAnimationOff") },
          { id: "bubbles", label: t("settings.queuedPromptAnimationBubbles") },
          { id: "glow", label: t("settings.queuedPromptAnimationGlow") },
          { id: "wave", label: t("settings.queuedPromptAnimationWave") },
        ]}
        onChange={(value) =>
          void saveSettings({
            queuedPromptAnimation: resolveQueuedPromptAnimation({
              queuedPromptAnimation: value,
            }),
          })
        }
      />
    </SettingsRow>
  );
}
