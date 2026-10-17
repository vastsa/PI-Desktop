/**
 * Settings destination for paired remote `pi-host` machines (R2b pairing UX,
 * ADR 0286 §Registry).
 *
 * Inventory of `<dataDir>/remote-hosts.json` plus two Add actions that reveal
 * the SSH install or URL + pairing-token form on demand. Instructional copy
 * stays out of the renderer. The destination is marked Experimental on the
 * rail and page title; pairing and SSH bootstrap still call the same IPC. A password
 * typed into the SSH form lives in this component's state only; it is never
 * persisted or logged here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSshAuth, RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { remoteHostErrorKey } from "../../lib/remote-host-errors";
import { useAppStore } from "../../stores/app-store";
import { OverlayBackdrop,
  Badge,
  Button,
  Field,
  Input,
  PasswordInput,
  SegmentedControl,
  cx,
  portalOverlay,
} from "../ui";
import { IconLink, IconPlus } from "../icons";

type AddMode = "ssh" | "pair";

type PairForm = {
  url: string;
  pairingToken: string;
  label: string;
};

const EMPTY_FORM: PairForm = { url: "", pairingToken: "", label: "" };

function remoteHostStatusKey(host: RemoteHostSummary) {
  if (host.status === "connecting") return "settings.remoteHosts.statusConnecting";
  if (host.status === "reconnecting") return "settings.remoteHosts.statusReconnecting";
  if (host.status === "action-required") return "settings.remoteHosts.statusActionRequired";
  return host.connected ? "settings.remoteHosts.statusOnline" : "settings.remoteHosts.statusOffline";
}

type SshForm = {
  label: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
  auth: RemoteHostSshAuth;
  password: string;
};

const EMPTY_SSH_FORM: SshForm = {
  label: "",
  host: "",
  user: "",
  port: "",
  identityFile: "",
  auth: "key",
  password: "",
};

export function RemoteHostsPage() {
  const { t } = useTranslation();
  const { t: remoteT } = useTranslation("remote");
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const alive = useRef(true);
  const refreshGeneration = useRef(0);
  const showToast = useAppStore((state) => state.showToast);
  const openProject = useAppStore((state) => state.openProject);
  const [hosts, setHosts] = useState<RemoteHostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<PairForm>(EMPTY_FORM);
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [sshForm, setSshForm] = useState<SshForm>(EMPTY_SSH_FORM);
  const [installing, setInstalling] = useState(false);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const sshAddActionRef = useRef<HTMLButtonElement>(null);
  const pairAddActionRef = useRef<HTMLButtonElement>(null);
  const pendingAddFocus = useRef<HTMLButtonElement | null>(null);
  const sshIdentityFileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const result = await api.listRemoteHosts();
      if (!alive.current || generation !== refreshGeneration.current) return;
      setHosts(result.hosts);
      setError(null);
    } catch (caught) {
      if (!alive.current || generation !== refreshGeneration.current) return;
      const message = t(remoteHostErrorKey(caught));
      setError(message);
    }
  }, [t]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = api.onSessionsChanged(() => void refresh());
    return () => { alive.current = false; refreshGeneration.current++; unsubscribe(); };
  }, [refresh]);

  const closeAddForm = useCallback(() => {
    pendingAddFocus.current = addMode === "pair" ? pairAddActionRef.current : sshAddActionRef.current;
    setAddMode(null);
    setForm(EMPTY_FORM);
    setSshForm(EMPTY_SSH_FORM);
  }, [addMode]);

  const reconnect = async (host: RemoteHostSummary) => {
    if (reconnecting) return;
    setReconnecting(host.hostKey);
    setError(null);
    try {
      await api.reconnectRemoteHost(host.hostKey);
      if (alive.current) await refresh();
    } catch (caught) {
      if (alive.current) setError(t(remoteHostErrorKey(caught)));
    } finally {
      if (alive.current) setReconnecting(null);
    }
  };

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const url = form.url.trim();
      const pairingToken = form.pairingToken.trim();
      const label = form.label.trim();
      if (!url || !pairingToken || !label) return;
      setPairing(true);
      try {
        const result = await api.pairRemoteHost({ url, pairingToken, label });
        showToast(t("settings.remoteHosts.pairSucceeded", { label: result.host.label }), {
          variant: "info",
        });
        closeAddForm();
        await refresh();
      } catch (caught) {
        const message = t(remoteHostErrorKey(caught));
        showToast(t("settings.remoteHosts.pairFailed", { message }), { variant: "error" });
      } finally {
        setPairing(false);
      }
    },
    [closeAddForm, form, refresh, showToast, t],
  );

  const remove = useCallback(
    async (host: RemoteHostSummary) => {
      setRemoving(host.hostKey);
      try {
        await api.removeRemoteHost(host.hostKey);
        showToast(t("settings.remoteHosts.removed", { label: host.label }), {
          variant: "info",
        });
        await refresh();
      } catch (caught) {
        const message = t(remoteHostErrorKey(caught));
        showToast(t("settings.remoteHosts.removeFailed", { message }), { variant: "error" });
      } finally {
        setRemoving(null);
      }
    },
    [refresh, showToast, t],
  );

  // Switching back to a key drops the secret from the draft: it is only ever
  // held while password mode is selected.
  const selectSshAuth = useCallback((auth: RemoteHostSshAuth) => {
    setSshForm((prev) => ({
      ...prev,
      auth,
      password: auth === "key" ? "" : prev.password,
    }));
  }, []);

  const handleSshIdentityFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0] ?? null;
      // Reset so the same identity file can be selected again after a change.
      input.value = "";
      if (!file) return;

      const identityFile = api.getDroppedFilePath(file);
      if (!identityFile) {
        showToast(t("settings.remoteHosts.sshIdentityFileError"), { variant: "error" });
        return;
      }
      setSshForm((prev) => ({ ...prev, identityFile }));
    },
    [showToast, t],
  );

  const submitSsh = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const label = sshForm.label.trim();
      const host = sshForm.host.trim();
      if (!host || !label) return;
      const passwordMode = sshForm.auth === "password";
      // Never trimmed: leading and trailing spaces can be part of a password,
      // so emptiness is tested separately from the value that is sent.
      const password = sshForm.password;
      if (passwordMode && !password) return;
      const user = sshForm.user.trim();
      const port = sshForm.port.trim();
      const identityFile = sshForm.identityFile;
      setInstalling(true);
      try {
        // Empty optional fields are dropped rather than sent blank, so main
        // falls back to the SSH config and the local user name. A password
        // replaces the key, so no `-i` is sent alongside it.
        const result = await api.bootstrapRemoteHost({
          label,
          host,
          ...(user ? { user } : {}),
          ...(port ? { port: Number(port) } : {}),
          ...(!passwordMode && identityFile ? { identityFile } : {}),
          ...(passwordMode && password ? { password } : {}),
        });
        showToast(t("settings.remoteHosts.sshSucceeded", { label: result.host.label }), {
          variant: "info",
        });
        closeAddForm();
        await refresh();
      } catch (caught) {
        const message = t(remoteHostErrorKey(caught));
        showToast(t("settings.remoteHosts.sshFailed", { message }), { variant: "error" });
      } finally {
        setInstalling(false);
      }
    },
    [closeAddForm, sshForm, refresh, showToast, t],
  );
  const busy = installing || pairing;

  useEffect(() => {
    if (addMode !== null || busy) return;
    const trigger = pendingAddFocus.current;
    if (!trigger) return;
    pendingAddFocus.current = null;
    trigger.focus();
  }, [addMode, busy]);

  useEffect(() => {
    if (addMode === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) closeAddForm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addMode, busy, closeAddForm]);

  const sshSubmitDisabled =
    installing ||
    !sshForm.host.trim() ||
    !sshForm.label.trim() ||
    (sshForm.auth === "password" && sshForm.password === "");
  const pairSubmitDisabled =
    pairing || !form.url.trim() || !form.pairingToken.trim() || !form.label.trim();

  return (
    <div className="settings-stack">
      {error && hosts !== null && <p role="alert">{error}</p>}
      <section className="settings-card-block">
        <div className="settings-card-heading-row settings-remote-host-add-heading">
          <h3 className="settings-card-heading">{t("settings.remoteHosts.addTitle")}</h3>
          <div className="settings-remote-host-add-actions">
            <Button
              ref={sshAddActionRef}
              id="remote-host-add-ssh"
              type="button"
              variant="primary"
              aria-haspopup="dialog"
              onClick={() => setAddMode("ssh")}
              disabled={busy}
            >
              <span className="settings-remote-host-add-button-content">
                <IconPlus size={14} />
                <span>{t("settings.remoteHosts.addSsh")}</span>
              </span>
            </Button>
            <Button
              ref={pairAddActionRef}
              id="remote-host-add-pair"
              type="button"
              variant="secondary"
              aria-haspopup="dialog"
              onClick={() => setAddMode("pair")}
              disabled={busy}
            >
              <span className="settings-remote-host-add-button-content">
                <IconLink size={14} />
                <span>{t("settings.remoteHosts.addPair")}</span>
              </span>
            </Button>
          </div>
        </div>
      </section>
      <div
        className="settings-remote-host-list"
        role="list"
        aria-busy={hosts === null || removing !== null}
      >
        {error && hosts === null ? (
          <div className="settings-remote-host-empty" role="alert">
            {t("settings.remoteHosts.listError")}
            <span className="settings-remote-host-empty-detail">{error}</span>
          </div>
        ) : hosts === null ? (
          <div className="settings-remote-host-empty" role="status">
            {t("settings.remoteHosts.loading")}
          </div>
        ) : hosts.length === 0 ? (
          <div className="settings-remote-host-empty" role="status">
            {t("settings.remoteHosts.empty")}
          </div>
        ) : (
          hosts.map((host) => (
            <article key={host.hostKey} className="settings-remote-host-card" role="listitem">
              <span
                className={cx(
                  "settings-remote-host-pulse",
                  host.connected && "is-online",
                )}
                aria-hidden="true"
              />
              <div className="settings-remote-host-copy">
                <div className="settings-remote-host-name">{host.label}</div>
                <div className="settings-remote-host-meta">
                  {host.transport === "ssh"
                    ? t("settings.remoteHosts.transportSsh")
                    : host.url}
                </div>
              </div>
              <span className="settings-remote-host-card-actions">
                <Badge tone={host.connected ? "success" : host.status === "action-required" ? "warning" : "neutral"}>
                  {t(remoteHostStatusKey(host))}
                </Badge>
                <Button variant="secondary" onClick={() => void openProject({ remoteHostKey: host.hostKey })}>
                  {remoteT("newProject")}
                </Button>
                <Button variant="ghost" disabled={reconnecting !== null} onClick={() => void reconnect(host)}>
                  {reconnecting === host.hostKey ? remoteT("loading") : remoteT("reconnect")}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={removing === host.hostKey}
                  onClick={() => void remove(host)}
                >
                  {removing === host.hostKey
                    ? t("settings.remoteHosts.removing")
                    : t("settings.remoteHosts.remove")}
                </Button>
              </span>
            </article>
          ))
        )}
      </div>

      {addMode !== null &&
        portalOverlay(
          <OverlayBackdrop
            className="overlay settings-remote-host-add-overlay"
            role="presentation"
            onClick={(event) => {
              if (event.target === event.currentTarget && !busy) closeAddForm();
            }}
          >
            <div
              className="dialog settings-remote-host-add-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-remote-host-add-dialog-title"
              onClick={(event) => event.stopPropagation()}
            >
              <h3
                id="settings-remote-host-add-dialog-title"
                className="settings-remote-host-add-dialog-title"
              >
                {t("settings.remoteHosts.addTitle")} · {t(
                  addMode === "ssh" ? "settings.remoteHosts.addSsh" : "settings.remoteHosts.addPair",
                )}
              </h3>
              <form
                id="remote-host-add-panel-ssh"
                aria-labelledby="settings-remote-host-add-dialog-title"
                hidden={addMode !== "ssh"}
                className="settings-remote-host-form settings-remote-host-add-panel"
                onSubmit={submitSsh}
              >
                <div className="settings-remote-host-form-row">
                  <Field label={t("settings.remoteHosts.fieldLabel")}>
                    <Input
                      value={sshForm.label}
                      autoFocus={addMode === "ssh"}
                      onChange={(event) =>
                        setSshForm((prev) => ({ ...prev, label: event.target.value }))
                      }
                      placeholder={t("settings.remoteHosts.fieldLabelPlaceholder")}
                      aria-label={t("settings.remoteHosts.fieldLabel")}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={installing}
                    />
                  </Field>
                  <Field label={t("settings.remoteHosts.sshHost")}>
                    <Input
                      value={sshForm.host}
                      onChange={(event) =>
                        setSshForm((prev) => ({ ...prev, host: event.target.value }))
                      }
                      placeholder={t("settings.remoteHosts.sshHostPlaceholder")}
                      aria-label={t("settings.remoteHosts.sshHost")}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={installing}
                    />
                  </Field>
                </div>

                <div className="settings-remote-host-form-row is-narrow-port">
                  <Field label={t("settings.remoteHosts.sshUser")}>
                    <Input
                      value={sshForm.user}
                      onChange={(event) =>
                        setSshForm((prev) => ({ ...prev, user: event.target.value }))
                      }
                      aria-label={t("settings.remoteHosts.sshUser")}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={installing}
                    />
                  </Field>
                  <Field label={t("settings.remoteHosts.sshPort")}>
                    <Input
                      value={sshForm.port}
                      onChange={(event) =>
                        setSshForm((prev) => ({ ...prev, port: event.target.value }))
                      }
                      aria-label={t("settings.remoteHosts.sshPort")}
                      inputMode="numeric"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={installing}
                    />
                  </Field>
                </div>

                <div className="settings-remote-host-form-auth">
                  <div
                    className="text-sm text-text-secondary"
                    id="settings-remote-host-auth-label"
                  >
                    {t("settings.remoteHosts.sshAuthMode")}
                  </div>
                  <SegmentedControl
                    value={sshForm.auth}
                    onChange={(auth) => selectSshAuth(auth)}
                    options={[
                      { value: "key", label: t("settings.remoteHosts.sshAuthKey") },
                      { value: "password", label: t("settings.remoteHosts.sshAuthPassword") },
                    ]}
                    label={t("settings.remoteHosts.sshAuthMode")}
                    disabled={installing}
                  />
                </div>

                {sshForm.auth === "key" ? (
                  <Field label={t("settings.remoteHosts.sshIdentityFile")}>
                    <div className="settings-remote-host-identity-file">
                      <Input
                        value={sshForm.identityFile}
                        placeholder={t("settings.remoteHosts.sshIdentityFilePlaceholder")}
                        aria-label={t("settings.remoteHosts.sshIdentityFile")}
                        autoComplete="off"
                        readOnly
                        disabled={installing}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => sshIdentityFileInput.current?.click()}
                        disabled={installing}
                      >
                        {t("settings.remoteHosts.sshIdentityFileChoose")}
                      </Button>
                      {sshForm.identityFile && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setSshForm((prev) => ({ ...prev, identityFile: "" }))}
                          disabled={installing}
                        >
                          {t("settings.remoteHosts.sshIdentityFileClear")}
                        </Button>
                      )}
                      {/* Key files often have no extension, so do not restrict file types. */}
                      <input
                        ref={sshIdentityFileInput}
                        className="settings-remote-host-identity-file-input"
                        type="file"
                        tabIndex={-1}
                        aria-hidden="true"
                        onChange={handleSshIdentityFileChange}
                        disabled={installing}
                      />
                    </div>
                  </Field>
                ) : (
                  <Field label={t("settings.remoteHosts.sshPassword")}>
                    <PasswordInput
                      value={sshForm.password}
                      onChange={(event) =>
                        setSshForm((prev) => ({ ...prev, password: event.target.value }))
                      }
                      placeholder={t("settings.remoteHosts.sshPasswordPlaceholder")}
                      aria-label={t("settings.remoteHosts.sshPassword")}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={installing}
                      showLabel={t("settings.remoteHosts.sshShowPassword")}
                      hideLabel={t("settings.remoteHosts.sshHidePassword")}
                    />
                  </Field>
                )}

                <div className="settings-remote-host-form-actions">
                  <Button type="button" variant="ghost" disabled={installing} onClick={closeAddForm}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" variant="primary" disabled={sshSubmitDisabled}>
                    {installing
                      ? t("settings.remoteHosts.sshRunning")
                      : t("settings.remoteHosts.sshAction")}
                  </Button>
                </div>
              </form>

              <form
                id="remote-host-add-panel-pair"
                aria-labelledby="settings-remote-host-add-dialog-title"
                hidden={addMode !== "pair"}
                className="settings-remote-host-form settings-remote-host-add-panel"
                onSubmit={submit}
              >
                <div className="settings-remote-host-form-row">
                  <Field label={t("settings.remoteHosts.fieldLabel")}>
                    <Input
                      value={form.label}
                      autoFocus={addMode === "pair"}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, label: event.target.value }))
                      }
                      placeholder={t("settings.remoteHosts.fieldLabelPlaceholder")}
                      aria-label={t("settings.remoteHosts.fieldLabel")}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pairing}
                    />
                  </Field>
                  <Field label={t("settings.remoteHosts.fieldUrl")}>
                    <Input
                      value={form.url}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, url: event.target.value }))
                      }
                      placeholder={t("settings.remoteHosts.fieldUrlPlaceholder")}
                      aria-label={t("settings.remoteHosts.fieldUrl")}
                      inputMode="url"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={pairing}
                    />
                  </Field>
                </div>
                <Field label={t("settings.remoteHosts.fieldPairingToken")}>
                  <Input
                    value={form.pairingToken}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, pairingToken: event.target.value }))
                    }
                    placeholder={t("settings.remoteHosts.fieldPairingTokenPlaceholder")}
                    aria-label={t("settings.remoteHosts.fieldPairingToken")}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    type="password"
                    disabled={pairing}
                  />
                </Field>
                <div className="settings-remote-host-form-actions">
                  <Button type="button" variant="ghost" disabled={pairing} onClick={closeAddForm}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" variant="primary" disabled={pairSubmitDisabled}>
                    {pairing
                      ? t("settings.remoteHosts.pairing")
                      : t("settings.remoteHosts.pair")}
                  </Button>
                </div>
              </form>
            </div>
          </OverlayBackdrop>,
        )}
    </div>
  );
}
