/**
 * macOS-only appearance switch for the native window surface (ADR 0332).
 *
 * Electron fixes `transparent` when a window is created, so the choice cannot
 * be applied to the window that is already on screen: it is persisted for the
 * next launch. The row reads the surface the main process actually created and
 * shows the restart hint only while the switch disagrees with it.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { SettingsRow } from "../../features/settings/primitives";
import { Badge, SettingsToggle } from "../ui";

export function MacosWindowTranslucencyRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Translucency is the shipped look, so only an explicit `false` turns it off.
  const translucent = settings.macosWindowTranslucency !== false;
  // `null` until the running window reports its surface; an unreadable state
  // keeps the hint hidden rather than claiming a restart is needed.
  const [applied, setApplied] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void api
      .windowControl("getState")
      .then((state) => {
        if (mounted) setApplied(state.macosWindowTranslucency);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <SettingsRow
      title={t("settings.windowTranslucency")}
      description={t("settings.windowTranslucencyDesc")}
      detail={
        applied !== null && applied !== translucent ? (
          <Badge tone="warning">{t("settings.windowTranslucencyRestart")}</Badge>
        ) : undefined
      }
    >
      <SettingsToggle
        checked={translucent}
        label={t("settings.windowTranslucency")}
        onChange={() =>
          void saveSettings({ macosWindowTranslucency: !translucent })
        }
      />
    </SettingsRow>
  );
}
