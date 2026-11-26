import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, SettingsToggle, cx } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { IconPlus, IconSmartphone, IconWifi } from "../../components/icons";
import { formatUpdated } from "../../lib/project-archive";
import { SettingsCard, SettingsRow } from "../settings/primitives";
import { CopyButton, LanPairDialog } from "./LanPairDialog";
import { LAN_DEFAULT_PORT, useLanWebUiAdmin } from "./use-lan-webui-admin";

export function LanWebUiSection() {
  const { t, i18n } = useTranslation("lan");
  const { view, busy, error, loadFailed, run, refresh, clearError } = useLanWebUiAdmin();
  const [preferredAddress, setPreferredAddress] = useState("");
  const [port, setPort] = useState(String(LAN_DEFAULT_PORT));
  const [portError, setPortError] = useState(false);
  const [pairing, setPairing] = useState<ReadonlySet<string> | null>(null);
  const portErrorId = useId();
  const addDeviceRef = useRef<HTMLButtonElement>(null);
  const restoreAddFocus = useRef(false);

  const running = view?.running === true;
  const enabled = view?.enabled ?? running;
  const interfaces = view?.interfaces ?? [];
  const selectedAddress = preferredAddress || view?.address;
  const address = running ? view?.address
    : selectedAddress ? interfaces.find((entry) => entry.address === selectedAddress)?.address : interfaces[0]?.address;
  const localOnly = address === "127.0.0.1";
  const paired = pairing && !busy && view?.code === null && view.devices.some((entry) => !pairing.has(entry.id));

  useEffect(() => {
    if (view?.address) setPreferredAddress(view.address);
    if (view?.port) setPort(String(view.port));
  }, [view?.address, view?.port]);

  useEffect(() => {
    if (pairing && (!running || paired)) setPairing(null);
  }, [paired, pairing, running]);

  useEffect(() => {
    if (pairing || busy || !restoreAddFocus.current) return;
    restoreAddFocus.current = false;
    addDeviceRef.current?.focus({ preventScroll: true });
  }, [busy, pairing]);

  const close = () => {
    clearError();
    setPairing(null);
  };
  const start = () => {
    const parsed = Number(port);
    const invalid = !Number.isInteger(parsed) || parsed < 1024 || parsed > 65535;
    setPortError(invalid);
    if (!invalid && address) void run({ kind: "start", address, port: parsed });
  };
  const toggle = () => {
    if (enabled) void run({ kind: "stop" });
    else start();
  };

  const errorText = error ? t(`lan:errors.${error}`, { defaultValue: t("lan:errors.FAILED") }) : null;
  const portErrorText = portError ? t("lan:errors.INVALID_PORT") : error === "PORT_IN_USE" ? errorText : null;
  const time = (ts: number) => formatUpdated(ts, i18n.language);
  const status = loadFailed ? t("statusUnavailable") : !view ? t("statusLoading")
    : running ? t("statusOn", { count: view.devices.length }) : enabled ? t("statusNotRunning") : t("statusOff");

  return (
    <>
      <SettingsCard title={t("title")} caption={t("caption")}>
        <SettingsRow
          title={t("enable")}
          description={t("enableHelp")}
          detail={(
            <span className="lan-status" role="status">
              <span className={cx("settings-remote-host-pulse", running && !loadFailed && "is-online")} aria-hidden="true" />
              {status}
            </span>
          )}
        >
          {loadFailed && !view ? (
            <Button type="button" size="sm" onClick={refresh}>{t("retry")}</Button>
          ) : (
            <SettingsToggle checked={enabled} label={t("enable")} busy={busy} disabled={!view || (!enabled && !address)} onChange={toggle} />
          )}
        </SettingsRow>

        {running && view?.origin ? (
          <div className="lan-address">
            <span className="lan-address-icon" aria-hidden="true"><IconWifi size={18} /></span>
            <div className="lan-address-copy">
              <div className="lan-address-label">{t("address")}</div>
              <code className="lan-address-url">{view.origin}</code>
              <div className="lan-address-hint">{t(localOnly ? "localOnly" : "addressHint")}</div>
            </div>
            <CopyButton text={view.origin} />
          </div>
        ) : view ? (
          <>
            <SettingsRow nested title={t("network")} description={t("networkHelp")}>
              <SettingsMenuSelect
                label={t("network")}
                value={address ?? ""}
                disabled={busy || !interfaces.length}
                options={interfaces.map((entry) => ({
                  id: entry.address,
                  label: `${entry.address} · ${entry.address === "127.0.0.1" ? t("localOnly") : entry.name}`,
                }))}
                onChange={(next) => { setPreferredAddress(next); clearError(); }}
              />
            </SettingsRow>
            <SettingsRow nested title={t("port")}>
              <Input
                className={cx("lan-port-input", !!portErrorText && "is-invalid")}
                aria-label={t("port")}
                aria-invalid={!!portErrorText || undefined}
                aria-describedby={portErrorText ? portErrorId : undefined}
                inputMode="numeric"
                value={port}
                disabled={busy}
                onChange={(event) => {
                  setPortError(false);
                  clearError();
                  setPort(event.target.value.replace(/\D/g, "").slice(0, 5));
                }}
              />
            </SettingsRow>
          </>
        ) : null}

        {!pairing && (portErrorText || errorText) ? (
          <p id={portErrorId} className="lan-error" role="alert">{portErrorText || errorText}</p>
        ) : null}
        {enabled && !running ? (
          <Button type="button" size="sm" disabled={busy || !address} onClick={start}>{t("retry")}</Button>
        ) : null}
      </SettingsCard>

      {running && view ? (
        <SettingsCard
          title={t("devices")}
          action={(
            <Button ref={addDeviceRef} type="button" variant="primary" disabled={busy} onClick={() => {
              clearError();
              restoreAddFocus.current = true;
              setPairing(new Set(view.devices.map((entry) => entry.id)));
              void run({ kind: "issueCode" });
            }}>
              <IconPlus size={14} aria-hidden="true" />
              {t("addDevice")}
            </Button>
          )}
        >
          {view.devices.length ? (
            <ul className="lan-devices" role="list" aria-label={t("devices")}>
              {view.devices.map((entry) => (
                <li key={entry.id} className="lan-device">
                  <span className="lan-device-icon" aria-hidden="true"><IconSmartphone size={16} /></span>
                  <div className="lan-device-copy">
                    <div className="lan-device-name">{entry.label}</div>
                    <div className="lan-device-meta">{t("activeAt", { time: time(entry.lastActiveAt) })}</div>
                  </div>
                  <div className="lan-device-actions">
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run({ kind: "revoke", id: entry.id })}>{t("remove")}</Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="lan-devices-empty" role="status">
              <IconSmartphone size={18} aria-hidden="true" />
              {t("noDevices")}
            </div>
          )}
        </SettingsCard>
      ) : null}

      {pairing && !paired && view?.origin ? (
        <LanPairDialog
          origin={view.origin}
          code={view.code}
          busy={busy}
          error={errorText}
          issueCode={() => void run({ kind: "issueCode" })}
          onClose={close}
        />
      ) : null}
    </>
  );
}
