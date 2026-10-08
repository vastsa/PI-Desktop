/**
 * Jev on the model configuration page (D625, settings IA).
 *
 * The card is the state of the integration: whether a TypeSafe key is stored,
 * whether the classifier is on for Agent mode, and the actions that change
 * either. It is only there once Jev has been added — before that it would be a
 * second place to paste a key, and adding stays where every other service is
 * added. The key itself is entered in the service dialog, which checks it
 * against TypeSafe before anything is kept.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, SettingsToggle } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { removeJevService } from "./jev-config";
import { persistJevEnabled, useJevKeyStatus } from "./jev-app-config";

type BusyAction = "toggle" | "remove" | null;

export type JevSettingsCardProps = {
  settings?: AppSettings;
  /** Opens the Jev service dialog, the one place a key is entered. */
  onConfigure: () => void;
  /** Bumped when that dialog stored a key, so this card re-reads the state. */
  statusRevision?: number;
};

export function JevSettingsCard({
  settings,
  onConfigure,
  statusRevision = 0,
}: JevSettingsCardProps) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [keyStatus, setKeyStatus] = useJevKeyStatus(statusRevision);
  const [busy, setBusy] = useState<BusyAction>(null);
  const enabled = settings?.jevEnabled === true;
  const configured = keyStatus === "configured";
  /*
    Jev is one of the services the user adds from "Add service", so an install
    without it has nothing to show here: a card would only be a second place to
    paste a key. It appears once a key is stored, and it stays while a Host that
    cannot answer refuses to say either way or an enabled setting contradicts a
    missing key — hiding a configured install is the worse failure.
  */
  if (!configured && !enabled && keyStatus !== "unavailable") return null;

  const fail = (error: unknown) => {
    showToast(error instanceof Error ? error.message : String(error), {
      variant: "error",
    });
  };

  const toggleEnabled = async () => {
    if (!settings || (!enabled && !configured)) return;
    setBusy("toggle");
    try {
      await persistJevEnabled(!enabled);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async () => {
    setBusy("remove");
    try {
      await removeJevService({
        setEnabled: persistJevEnabled,
        deleteKey: () => api.deleteJevApiKey(),
      });
      setKeyStatus("missing");
      showToast(t("settings.jevKeyRemoved"), { variant: "success" });
    } catch (error) {
      setKeyStatus((await api.hasJevApiKey().catch(() => configured)) ? "configured" : "missing");
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const keyStatusText = configured
    ? t("settings.jevKeyConfigured")
    : keyStatus === "unavailable"
      ? t("settings.jevKeyStatusUnavailable")
      : keyStatus === "loading"
        ? t("settings.jevKeyStatusChecking")
        : t("settings.jevKeyMissing");

  return (
    <SettingsCard
      title={t("settings.jevTitle")}
      description={t("settings.jevDescription")}
    >
      <SettingsRow
        title={t("settings.jevEnable")}
        description={t("settings.jevEnableDescription")}
        detail={keyStatusText}
      >
        <div className="jev-settings-controls">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={onConfigure}
          >
            {configured ? t("settings.jevReplaceKey") : t("settings.jevConfigureKey")}
          </Button>
          {configured ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void removeKey()}
            >
              {t("settings.jevRemoveKey")}
            </Button>
          ) : null}
          <SettingsToggle
            checked={enabled}
            label={t("settings.jevEnable")}
            disabled={busy !== null || !settings || (!configured && !enabled)}
            busy={busy === "toggle"}
            onChange={() => void toggleEnabled()}
          />
        </div>
      </SettingsRow>
      <p className="jev-settings-privacy-note">{t("settings.jevPrivacyNotice")}</p>
    </SettingsCard>
  );
}
