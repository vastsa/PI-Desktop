import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_DOH_SERVER_URL,
  DOH_SERVER_URL_MAX_LENGTH,
  normalizeNetworkDns,
  validateNetworkDns,
  type AppSettings,
  type NetworkDnsSettings,
} from "@pi-desktop/shared";
import { Input, SettingsToggle } from "../ui";
import { SettingsRow } from "../../features/settings/primitives";
import { useAppStore } from "../../stores/app-store";

/** Native DNS controls share the existing Network card and settings write path. */
export function NetworkDnsSection({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const saved = normalizeNetworkDns(settings.networkDns);
  const enabled = saved.mode === "doh";
  const [urlDraft, setUrlDraft] = useState(saved.serverUrl ?? DEFAULT_DOH_SERVER_URL);
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const errorId = useId();
  const showToast = useAppStore((state) => state.showToast);

  useEffect(() => {
    setUrlDraft(saved.serverUrl ?? DEFAULT_DOH_SERVER_URL);
    setInvalid(false);
  }, [saved.serverUrl]);

  const persist = async (next: NetworkDnsSettings) => {
    if (savingRef.current) return;
    const validated = validateNetworkDns(next);
    if (!validated.ok) { setInvalid(true); return; }
    setInvalid(false);
    savingRef.current = true;
    setSaving(true);
    try {
      await saveSettings({ networkDns: validated.value });
      setUrlDraft(validated.value.serverUrl ?? DEFAULT_DOH_SERVER_URL);
    } catch {
      showToast(t("settings.dnsSaveError"), { variant: "error" });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const chooseMode = () => {
    // An invalid uncommitted endpoint must never prevent disabling secure DNS.
    const draft = validateNetworkDns({ ...saved, serverUrl: urlDraft.trim() || DEFAULT_DOH_SERVER_URL });
    const preferences = draft.ok ? draft.value : saved;
    void persist({ ...preferences, mode: enabled ? "system" : "doh" });
  };

  const commitUrl = () => {
    const serverUrl = urlDraft.trim() || DEFAULT_DOH_SERVER_URL;
    if (serverUrl === (saved.serverUrl ?? DEFAULT_DOH_SERVER_URL)) {
      setInvalid(false);
      return;
    }
    void persist({ ...saved, serverUrl });
  };

  return (
    <>
      <SettingsRow title={t("settings.dns")} description={t("settings.dnsDesc")}>
        <SettingsToggle checked={enabled} disabled={saving} label={t("settings.dns")} onChange={chooseMode} />
      </SettingsRow>
      {enabled ? (
        <>
          <SettingsRow title={t("settings.dnsServer")} description={t("settings.dnsServerDesc")}>
            <div className="settings-proxy-control">
              <Input
                type="url"
                value={urlDraft}
                maxLength={DOH_SERVER_URL_MAX_LENGTH}
                disabled={saving}
                placeholder={t("settings.dnsServerPlaceholder")}
                aria-label={t("settings.dnsServer")}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                onChange={(event) => { setUrlDraft(event.target.value); setInvalid(false); }}
                onBlur={commitUrl}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                }}
              />
              {invalid ? (
                <span id={errorId} className="settings-command-shell-state error" role="status">
                  {t("settings.dnsInvalid")}
                </span>
              ) : null}
            </div>
          </SettingsRow>
          <SettingsRow title={t("settings.dnsFallback")} description={t("settings.dnsFallbackDesc")}>
            <SettingsToggle
              checked={saved.allowSystemFallback === true}
              disabled={saving}
              label={t("settings.dnsFallback")}
              onChange={() => void persist({ ...saved, allowSystemFallback: !saved.allowSystemFallback })}
            />
          </SettingsRow>
        </>
      ) : null}
    </>
  );
}
