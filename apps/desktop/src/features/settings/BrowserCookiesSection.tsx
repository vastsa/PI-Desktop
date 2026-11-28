import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserCookieImportResult, BrowserCookieImportStatus } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "./primitives";

type Notice = { kind: "imported"; result: BrowserCookieImportResult } | { kind: "cleared" };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * User-triggered import of Chrome login cookies into the work browser.
 * Nothing here runs without an explicit click; the agent has no path to it.
 */
export function BrowserCookiesSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserCookieImportStatus | null>(null);
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const operation = useRef(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const next = await api.getBrowserCookieImportStatus();
      if (!mounted.current) return;
      setStatus(next);
      setProfile((current) => next.profiles.some((item) => item.id === current) ? current : next.profiles[0]?.id ?? "");
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const run = async (action: () => Promise<Notice>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (mounted.current) setNotice(next);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        setConfirmClear(false);
      }
    }
  };

  const importCookies = () => run(async () => {
    const result = await api.importBrowserCookies({ profile });
    return { kind: "imported", result };
  });

  const clearCookies = () => run(async () => {
    await api.clearBrowserCookies();
    return { kind: "cleared" };
  });

  const supported = status?.supported === true;
  const hasProfiles = supported && status.profiles.length > 0;
  const importDisabled = busy || !hasProfiles || !profile;

  return (
    <SettingsCard title={t("settings.browserCookies.title")}>
      <SettingsRow
        title={t("settings.browserCookies.profile")}
        description={t("settings.browserCookies.description")}
        detail={!status
          ? t("common.loading")
          : !supported
            ? t("settings.browserCookies.unsupported")
            : hasProfiles
              ? null
              : t("settings.browserCookies.noProfiles")}
      >
        {hasProfiles ? <SettingsMenuSelect
          value={profile}
          options={status.profiles.map((item) => ({ id: item.id, label: item.name }))}
          onChange={setProfile}
          label={t("settings.browserCookies.profile")}
          disabled={busy}
        /> : null}
      </SettingsRow>
      <SettingsRow
        title={t("settings.browserCookies.importAction")}
        description={t("settings.browserCookies.keychainHint")}
      >
        <Button variant="secondary" disabled={importDisabled} onClick={() => void importCookies()}>
          {busy ? t("settings.browserCookies.importing") : t("settings.browserCookies.import")}
        </Button>
      </SettingsRow>
      <SettingsRow
        title={t("settings.browserCookies.clearTitle")}
        description={t("settings.browserCookies.clearHint")}
      >
        {confirmClear ? <>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirmClear(false)}>{t("common.cancel")}</Button>
          <Button disabled={busy} onClick={() => void clearCookies()}>{t("settings.browserCookies.clearConfirm")}</Button>
        </> : <Button variant="secondary" disabled={busy} onClick={() => setConfirmClear(true)}>
          {t("settings.browserCookies.clear")}
        </Button>}
      </SettingsRow>
      {notice?.kind === "imported" ? <p className="settings-storage-message" role="status">
        {t("settings.browserCookies.imported", {
          imported: notice.result.imported,
          skipped: notice.result.skipped,
          failed: notice.result.failed,
        })}
      </p> : null}
      {notice?.kind === "cleared" ? <p className="settings-storage-message" role="status">{t("settings.browserCookies.cleared")}</p> : null}
      {error ? <p className="settings-storage-message error" role="alert">{t("settings.browserCookies.error", { error })}</p> : null}
    </SettingsCard>
  );
}
