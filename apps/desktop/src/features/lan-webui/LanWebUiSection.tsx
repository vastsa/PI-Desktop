import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LanAdminAction } from "@pi-desktop/shared";
import { Button, Input, SettingsToggle, cx } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { IconPlus, IconSmartphone, IconWifi } from "../../components/icons";
import { formatUpdated } from "../../lib/project-archive";
import { SettingsCard, SettingsRow } from "../settings/primitives";
import { NEW_DEVICE_GRANTS } from "./LanGrantsEditor";
import { CopyButton, LanAccessDialog, LanPairDialog } from "./LanPairDialog";
import { LAN_DEFAULT_PORT, useLanWebUiAdmin } from "./use-lan-webui-admin";

type Dialog =
  | { kind: "pair"; existingRequests: Set<string> }
  | { kind: "approve" | "edit"; id: string };

export function LanWebUiSection() {
  const { t, i18n } = useTranslation("lan");
  const { view, busy, error, loadFailed, run, refresh, clearError } = useLanWebUiAdmin();
  const [preferredAddress, setPreferredAddress] = useState("");
  const [port, setPort] = useState(String(LAN_DEFAULT_PORT));
  const [portError, setPortError] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const portErrorId = useId();
  const addDeviceRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const running = view?.running === true;
  const interfaces = view?.interfaces ?? [];
  const address = view?.address ?? interfaces.find((entry) => entry.address === preferredAddress)?.address ?? interfaces[0]?.address;
  const localOnly = address === "127.0.0.1";
  const pending = view?.pending;
  const devices = view?.devices;
  const request = dialog?.kind === "approve" ? pending?.find((entry) => entry.id === dialog.id) : undefined;
  const device = dialog?.kind === "edit" ? devices?.find((entry) => entry.id === dialog.id) : undefined;

  useEffect(() => {
    if (view?.address) setPreferredAddress(view.address);
    if (view?.port) setPort(String(view.port));
  }, [view?.address, view?.port]);

  useEffect(() => {
    if (!dialog) return;
    if (!running || (dialog.kind === "approve" && !request) || (dialog.kind === "edit" && !device)) {
      setDialog(null);
    } else if (dialog.kind === "pair" && !busy) {
      const received = pending?.find((entry) => !dialog.existingRequests.has(entry.id));
      if (received) setDialog({ kind: "approve", id: received.id });
    }
  }, [busy, device, dialog, pending, request, running]);

  useEffect(() => {
    if (dialog || busy || !opener.current) return;
    // A review button is gone after approval; return to Add device instead.
    const target = opener.current.isConnected ? opener.current : addDeviceRef.current;
    opener.current = null;
    target?.focus({ preventScroll: true });
  }, [busy, dialog]);

  const open = (next: Dialog, trigger: HTMLButtonElement) => {
    opener.current = trigger;
    clearError();
    setDialog(next);
  };
  const close = () => {
    clearError();
    setDialog(null);
  };
  const submit = async (action: LanAdminAction) => {
    if (await run(action)) close();
  };
  const toggle = () => {
    if (running) {
      void run({ kind: "stop" });
      return;
    }
    const parsed = Number(port);
    const invalid = !Number.isInteger(parsed) || parsed < 1024 || parsed > 65535;
    setPortError(invalid);
    if (!invalid && address) void run({ kind: "start", address, port: parsed });
  };

  const errorText = error ? t(`lan:errors.${error}`, { defaultValue: t("lan:errors.FAILED") }) : null;
  const portErrorText = portError ? t("lan:errors.INVALID_PORT") : error === "PORT_IN_USE" ? errorText : null;
  const time = (ts: number) => formatUpdated(ts, i18n.language);
  const list = new Intl.ListFormat(i18n.language || undefined, { style: "short" });
  const status = loadFailed ? t("statusUnavailable") : !view ? t("statusLoading")
    : running ? t("statusOn", { count: view.devices.length }) : t("statusOff");

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
            <SettingsToggle checked={running} label={t("enable")} busy={busy} disabled={!view || !address} onChange={toggle} />
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

        {!dialog && (portErrorText || errorText) ? (
          <p id={portErrorId} className="lan-error" role="alert">{portErrorText || errorText}</p>
        ) : null}
      </SettingsCard>

      {running && view ? (
        <SettingsCard
          title={t("devices")}
          caption={t("devicesCaption")}
          action={(
            <Button ref={addDeviceRef} type="button" variant="primary" disabled={busy} onClick={(event) => {
              open({ kind: "pair", existingRequests: new Set(view.pending.map((entry) => entry.id)) }, event.currentTarget);
              void run({ kind: "issueCode" });
            }}>
              <IconPlus size={14} aria-hidden="true" />
              {t("addDevice")}
            </Button>
          )}
        >
          {view.pending.length || view.devices.length ? (
            <ul className="lan-devices" role="list" aria-label={t("devices")}>
              {view.pending.map((entry) => (
                <li key={entry.id} className="lan-device is-request">
                  <span className="lan-device-icon" aria-hidden="true"><IconSmartphone size={16} /></span>
                  <div className="lan-device-copy">
                    <div className="lan-device-name">{t("requestTitle", { label: entry.label })}</div>
                    <div className="lan-device-meta">{t("requestedAt", { time: time(entry.createdAt) })}</div>
                  </div>
                  <div className="lan-device-actions">
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run({ kind: "deny", id: entry.id })}>{t("deny")}</Button>
                    <Button type="button" size="sm" variant="primary" disabled={busy} onClick={(event) => open({ kind: "approve", id: entry.id }, event.currentTarget)}>{t("review")}</Button>
                  </div>
                </li>
              ))}
              {view.devices.map((entry) => {
                const grants = entry.grants;
                const actions = [grants.chat ? t("canChat") : "", grants.organize ? t("canOrganize") : ""].filter(Boolean);
                return (
                  <li key={entry.id} className="lan-device">
                    <span className="lan-device-icon" aria-hidden="true"><IconSmartphone size={16} /></span>
                    <div className="lan-device-copy">
                      <div className="lan-device-name">{entry.label}</div>
                      <div className="lan-device-meta">
                        {[
                          t("scopeAll"),
                          grants.temporary ? t("scopeTemporary") : null,
                          actions.length ? list.format(actions) : t("viewOnly"),
                          t("activeAt", { time: time(entry.lastActiveAt) }),
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div className="lan-device-actions">
                      <Button type="button" size="sm" disabled={busy} onClick={(event) => open({ kind: "edit", id: entry.id }, event.currentTarget)}>{t("permissions")}</Button>
                      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run({ kind: "revoke", id: entry.id })}>{t("remove")}</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="lan-devices-empty" role="status">
              <IconSmartphone size={18} aria-hidden="true" />
              {t("noDevices")}
            </div>
          )}
        </SettingsCard>
      ) : null}

      {dialog?.kind === "pair" && view?.origin ? (
        <LanPairDialog
          origin={view.origin}
          code={view.code}
          busy={busy}
          error={errorText}
          issueCode={() => void run({ kind: "issueCode" })}
          onClose={close}
        />
      ) : null}
      {request && view ? (
        <LanAccessDialog
          key={request.id}
          mode="approve"
          label={request.label}
          initial={NEW_DEVICE_GRANTS}
          busy={busy}
          error={errorText}
          onSubmit={(grants) => void submit({ kind: "confirm", id: request.id, grants })}
          onDeny={() => void submit({ kind: "deny", id: request.id })}
          onClose={close}
        />
      ) : null}
      {device && view ? (
        <LanAccessDialog
          key={device.id}
          mode="edit"
          label={device.label}
          initial={device.grants}
          busy={busy}
          error={errorText}
          onSubmit={(grants) => void submit({ kind: "update", id: device.id, grants })}
          onClose={close}
        />
      ) : null}
    </>
  );
}
