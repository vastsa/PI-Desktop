/**
 * Conversation destination (D684): how a transcript is presented and how the
 * composer takes input.
 *
 * These rows used to sit in the AI destination's Defaults card, between the
 * permission mode and the command shell. Nothing here changes what the model
 * does — the Display card says so once, so no row has to repeat it.
 */
import type { AppSettings } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SettingsToggle } from "../../../components/ui";
import { ShowThinkingRow } from "../../../components/settings/ShowThinkingRow";
import { TranscriptDisplayModeRow } from "../../../components/settings/TranscriptDisplayModeRow";
import {
  AutoCollapseSettledGroupsRow,
  AutoCollapseThinkingRow,
} from "../../../components/settings/TranscriptFoldingRows";
import {
  ContextUsageDisplayRow,
  LargePasteThresholdRow,
  LinkOpenTargetRow,
  SettingsCard,
  SettingsRow,
} from "../primitives";

export function ConversationSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.chatDisplay")} caption={t("settings.chatDisplayCaption")}>
        <ShowThinkingRow settings={settings} saveSettings={saveSettings} />
        <AutoCollapseThinkingRow settings={settings} saveSettings={saveSettings} />
        <TranscriptDisplayModeRow settings={settings} saveSettings={saveSettings} />
        <AutoCollapseSettledGroupsRow settings={settings} saveSettings={saveSettings} />
        <ContextUsageDisplayRow settings={settings} saveSettings={saveSettings} />
        <SettingsRow
          title={t("settings.smoothStreaming")}
          description={t("settings.smoothStreamingDesc")}
        >
          <SettingsToggle
            checked={settings.smoothStreaming !== false}
            label={t("settings.smoothStreaming")}
            onChange={() => void saveSettings({ smoothStreaming: !(settings.smoothStreaming !== false) })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.inlineVisualizations")}
          description={t("settings.inlineVisualizationsDesc")}
        >
          <SettingsToggle
            checked={settings.inlineVisualizations === true}
            label={t("settings.inlineVisualizations")}
            onChange={() =>
              void saveSettings({
                inlineVisualizations: settings.inlineVisualizations !== true,
              })
            }
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("settings.chatInput")}>
        <SettingsRow
          title={t("settings.enterToSend")}
          description={t("settings.enterToSendDesc")}
        >
          <SettingsToggle
            checked={settings.enterToSend}
            label={t("settings.enterToSend")}
            onChange={() => void saveSettings({ enterToSend: !settings.enterToSend })}
          />
        </SettingsRow>
        <LargePasteThresholdRow settings={settings} saveSettings={saveSettings} />
        <LinkOpenTargetRow settings={settings} saveSettings={saveSettings} />
      </SettingsCard>
    </div>
  );
}
