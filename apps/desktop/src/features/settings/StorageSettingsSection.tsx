import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StorageInfo } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

type StorageAction = "migrate" | "cache" | "backup";

function formatSize(bytes: number, language: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const size = Math.max(0, bytes);
  const index = size > 0 ? Math.min(4, Math.floor(Math.log(size) / Math.log(1024))) : 0;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(size / 1024 ** index)} ${units[index]}`;
}

/** Storage changes are completed by Main's offline restart workflow. */
export function StorageSettingsSection() {
  const { t, i18n } = useTranslation();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<StorageAction | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const operation = useRef(false);
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const language = i18n.resolvedLanguage ?? i18n.language ?? "en";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.getStorageInfo();
      if (mounted.current) setInfo(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  useEffect(() => {
    if (confirmation) {
      confirmationRef.current?.focus({ preventScroll: true });
      confirmationRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [confirmation]);

  const disabled = loading || busy || !info?.managed || Boolean(info.pendingPath);
  const choose = async () => {
    if (disabled || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const path = await api.chooseStorageDirectory();
      if (mounted.current && path) {
        setDestination(path);
        setConfirmation("migrate");
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const confirm = async () => {
    if (!confirmation || disabled || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      if (confirmation === "migrate" && destination) {
        await api.migrateStorage({ path: destination, language });
      } else if (confirmation === "cache") {
        await api.clearStorageCache({ language });
      } else if (confirmation === "backup") {
        await api.removeStorageBackup({ language });
      }
    } catch (cause) {
      operation.current = false;
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      }
    }
  };

  const confirmTitle = confirmation === "migrate"
    ? t("settings.storage.migrateTitle")
    : confirmation === "cache"
      ? t("settings.storage.cacheTitle")
      : t("settings.storage.backupTitle");

  return (
    <div className="settings-storage" aria-busy={loading || busy}>
      <SettingsCard title={t("settings.storage.title")}>
        {info ? <>
          <SettingsRow
            title={t("settings.storage.dataPath")}
            description={t("settings.storage.scope")}
            detail={<span className="settings-storage-path">{info.dataPath}</span>}
          >
            <Button variant="secondary" disabled={disabled} onClick={() => void choose()}>
              {t("settings.storage.choose")}
            </Button>
          </SettingsRow>
          <SettingsRow
            title={t("settings.storage.cache")}
            description={t("settings.storage.cacheScope")}
            detail={formatSize(info.cacheBytes, language)}
          >
            <Button variant="secondary" disabled={disabled || info.cacheBytes === 0} onClick={() => setConfirmation("cache")}>
              {t("settings.storage.clearCache")}
            </Button>
          </SettingsRow>
          {info.backupPaths.length > 0 ? <SettingsRow
            title={t("settings.storage.backup")}
            description={t("settings.storage.backupHint")}
            detail={info.backupPaths.map((path) => <div key={path} className="settings-storage-path">{path}</div>)}
          >
            <Button variant="secondary" disabled={disabled} onClick={() => setConfirmation("backup")}>
              {t("settings.storage.removeBackup")}
            </Button>
          </SettingsRow> : null}
          {!info.managed ? <p className="settings-storage-message" role="status">{t("settings.storage.environmentManaged")}</p> : null}
          {info.pendingPath ? <p className="settings-storage-message" role="status">{t("settings.storage.pending", { path: info.pendingPath })}</p> : null}
          {info.lastError ? <p className="settings-storage-message error" role="alert">{t("settings.storage.lastError", { error: info.lastError })}</p> : null}
        </> : <SettingsRow title={t("settings.storage.dataPath")}>
          {loading ? <span role="status">{t("common.loading")}</span> : <Button variant="secondary" onClick={() => void refresh()}>{t("settings.storage.retry")}</Button>}
        </SettingsRow>}
        {confirmation && info ? <div className="settings-storage-confirmation" role="region" aria-label={confirmTitle}>
          <h4 ref={confirmationRef} tabIndex={-1}>{confirmTitle}</h4>
          {confirmation === "migrate" ? <>
            <dl>
              <dt>{t("settings.storage.source")}</dt><dd>{info.dataPath}</dd>
              {info.browserPath !== info.dataPath ? <>
                <dt>{t("settings.storage.browserSource")}</dt><dd>{info.browserPath}</dd>
              </> : null}
              <dt>{t("settings.storage.destination")}</dt><dd>{destination}</dd>
            </dl>
            <p>{t("settings.storage.migrateHint")}</p>
            <p>{t("settings.storage.scope")}</p>
          </> : <p>{confirmation === "cache" ? t("settings.storage.cacheHint", { size: formatSize(info.cacheBytes, language) }) : t("settings.storage.backupHint")}</p>}
          <div className="settings-storage-actions">
            <Button variant="secondary" disabled={busy} onClick={() => { setConfirmation(null); setDestination(null); }}>{t("common.cancel")}</Button>
            <Button disabled={disabled} onClick={() => void confirm()}>{busy ? t("settings.storage.restarting") : t(confirmation === "migrate" ? "settings.storage.migrateRestart" : confirmation === "cache" ? "settings.storage.cacheRestart" : "settings.storage.backupRestart")}</Button>
          </div>
        </div> : null}
        {error ? <p className="settings-storage-message error" role="alert">{t("settings.storage.operationError", { error })}</p> : null}
        {busy && !confirmation ? <p className="settings-storage-message" role="status">{t("common.loading")}</p> : null}
      </SettingsCard>
    </div>
  );
}
