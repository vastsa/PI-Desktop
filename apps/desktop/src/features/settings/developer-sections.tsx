import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, CloseBehavior } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Button, SegmentedControl, SettingsToggle } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

export function DeveloperSection({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const enabled = settings.developerMode === true;

  const openConsole = async () => {
    try {
      await api.toggleDevTools(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  return (
    <SettingsCard title={t("settings.developer")}>
      <SettingsRow
        title={t("settings.developerMode")}
        description={t("settings.developerModeDesc")}
      >
        <SettingsToggle
          checked={enabled}
          label={t("settings.developerMode")}
          onChange={() => void saveSettings({ developerMode: !enabled })}
        />
      </SettingsRow>
      <SettingsRow
        title={t("settings.devTools")}
        description={enabled ? undefined : t("settings.devToolsDisabledHint")}
      >
        <Button variant="secondary" disabled={!enabled} onClick={() => void openConsole()}>
          {t("settings.openDevTools")}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}
/**
 * Windows/Linux only: how closing the main window behaves. The first close
 * prompts once (main-process dialog); the remembered choice can be changed
 * here between tray and quit, but never reverted to prompting.
 */
export function CloseBehaviorSection() {
  const { t } = useTranslation();
  const [behavior, setBehavior] = useState<CloseBehavior | null>(null);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getCloseBehavior()
      .then(({ behavior: next }) => {
        if (!cancelled) setBehavior(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The "ask" state (unset) is transient and cannot be re-selected: once a
  // choice is made it is remembered permanently. An unset preference shows
  // no active option.
  const options: [CloseBehavior, string][] = [
    ["tray", "settings.closeBehaviorTray"],
    ["quit", "settings.closeBehaviorQuit"],
  ];

  const choose = async (next: CloseBehavior) => {
    setSaveError(false);
    try {
      await api.setCloseBehavior(next);
      setBehavior(next);
    } catch {
      setSaveError(true);
    }
  };

  return (
    <SettingsCard title={t("settings.closeBehaviorTitle")}>
      <SettingsRow
        title={t("settings.closeBehaviorTitle")}
        description={t("settings.closeBehaviorDesc")}
      >
        <SegmentedControl<CloseBehavior>
          value={behavior ?? ("" as CloseBehavior)}
          onChange={(value) => void choose(value)}
          options={options.map(([value, labelKey]) => ({ value, label: t(labelKey) }))}
          label={t("settings.closeBehaviorTitle")}
        />
      </SettingsRow>
      {saveError ? (
        <span className="settings-command-shell-state error" role="status">
          {t("settings.closeBehaviorSaveError")}
        </span>
      ) : null}
    </SettingsCard>
  );
}
