import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { resolveShowThinking } from "../../lib/thinking-visibility";
import { resolveTranscriptDisplayMode } from "../../lib/transcript-display-mode";
import {
  resolveAutoCollapseSettledGroups,
  resolveAutoCollapseThinking,
} from "../../lib/transcript-folding";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

/*
 * The two switches behind a folded transcript (issue #2094).
 *
 * Both are sub-rows: each one only makes sense while the row above it is
 * offering content to fold. Hiding a sub-row never writes a value, so a reader
 * who turns `Show thinking` off and on again, or switches to the flat layout and
 * back, finds the choice they made still in place.
 */

/** Fold reasoning that is no longer streaming. */
export function AutoCollapseThinkingRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  // With `Show thinking` off no completed reasoning renders at all, so the
  // switch would have nothing to act on.
  if (!resolveShowThinking(settings)) return null;
  const collapse = resolveAutoCollapseThinking(settings);
  return (
    <SettingsRow
      nested
      title={t("settings.autoCollapseThinking")}
      description={t("settings.autoCollapseThinkingDesc")}
    >
      <SettingsToggle
        checked={collapse}
        label={t("settings.autoCollapseThinking")}
        onChange={() => void saveSettings({ autoCollapseThinking: !collapse })}
      />
    </SettingsRow>
  );
}

/** Fold activity groups that are no longer running. */
export function AutoCollapseSettledGroupsRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  // The flat layout renders rows without activity groups, so the switch has no
  // effect there; hiding it keeps the settings page honest about the mode.
  if (resolveTranscriptDisplayMode(settings) === "flat") return null;
  const collapse = resolveAutoCollapseSettledGroups(settings);
  return (
    <SettingsRow
      nested
      title={t("settings.autoCollapseSettledGroups")}
      description={t("settings.autoCollapseSettledGroupsDesc")}
    >
      <SettingsToggle
        checked={collapse}
        label={t("settings.autoCollapseSettledGroups")}
        onChange={() => void saveSettings({ autoCollapseSettledGroups: !collapse })}
      />
    </SettingsRow>
  );
}
