import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  resolveTranscriptDisplayMode,
  type TranscriptDisplayMode,
} from "../../lib/transcript-display-mode";
import { SettingsRow } from "../../features/settings/primitives";
import { SegmentedControl } from "../ui";

const MODE_OPTIONS = [
  { value: "flat", labelKey: "settings.transcriptDisplayModeFlat" },
  {
    value: "command-first",
    labelKey: "settings.transcriptDisplayModeCommandFirst",
  },
  {
    value: "fully-folded",
    labelKey: "settings.transcriptDisplayModeFullyFolded",
  },
] as const satisfies readonly {
  value: TranscriptDisplayMode;
  labelKey: string;
}[];

/**
 * Transcript process layout (Settings → AI → Defaults). Persists
 * `AppSettings.transcriptDisplayMode`; an absent or unknown value keeps the
 * released `fully-folded` layout.
 */
export function TranscriptDisplayModeRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const mode = resolveTranscriptDisplayMode(settings);
  return (
    <SettingsRow
      title={t("settings.transcriptDisplayMode")}
      description={t("settings.transcriptDisplayModeDesc")}
    >
      <SegmentedControl
        value={mode}
        onChange={(value) => void saveSettings({ transcriptDisplayMode: value })}
        options={MODE_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
        label={t("settings.transcriptDisplayMode")}
      />
    </SettingsRow>
  );
}
