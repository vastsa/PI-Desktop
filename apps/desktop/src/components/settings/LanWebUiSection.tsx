import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LanAdminAction, LanAdminView, LanGrants } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Badge, Button, Checkbox, CheckboxGroup, Input } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

const DEFAULT_PORT = 37180;
const POLL_MS = 2000;

const emptyGrants = (): LanGrants => ({ projectIds: [], temporary: false, chat: true, organize: true });

/** Settings → System: start the LAN WebUI, pair devices and revoke them. */
export function LanWebUiSection() {
  const { t } = useTranslation("lan");
  const [view, setView] = useState<LanAdminView | null>(null);
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, LanGrants>>({});
  const alive = useRef(true);

  const run = useCallback(async (action: LanAdminAction) => {
    try {
      const next = await api.lanWebUiAdmin(action);
      if (alive.current) setView(next);
    } catch {
      // The next poll reports the actual state.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void run({ kind: "state" });
    const timer = setInterval(() => void run({ kind: "state" }), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [run]);

  useEffect(() => {
    if (!view || address) return;
    setAddress(view.address ?? view.interfaces[0]?.address ?? "");
  }, [view, address]);

  const act = async (action: LanAdminAction) => {
    setBusy(true);
    try {
      await run(action);
    } finally {
      setBusy(false);
    }
  };

  const running = view?.running === true;
  // Keys live in the `lan` namespace (locales/lan.ts), not the main catalog.
  const errorText = view?.error ? t(`lan:errors.${view.error}`, { defaultValue: t("lan:errors.FAILED") }) : null;
  const projectOptions = (view?.projects ?? []).map((project) => ({ value: project.id, label: project.label }));
  const draftFor = (id: string) => drafts[id] ?? emptyGrants();
  const setDraft = (id: string, patch: Partial<LanGrants>) =>
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? emptyGrants()), ...patch } }));

  return (
    <SettingsCard title={t("title")} caption={t("caption")} description={t("description")}>
      <SettingsRow title={t("status")}>
        <Badge tone={running ? "success" : "neutral"}>{running ? t("running") : t("stopped")}</Badge>
      </SettingsRow>
      <SettingsRow title={t("address")}>
        <SettingsMenuSelect
          label={t("address")}
          value={address}
          disabled={running || busy}
          options={(view?.interfaces ?? []).map((entry) => ({ id: entry.address, label: `${entry.address} · ${entry.name}` }))}
          onChange={setAddress}
        />
      </SettingsRow>
      <SettingsRow title={t("port")}>
        <Input
          aria-label={t("port")}
          inputMode="numeric"
          value={port}
          disabled={running || busy}
          onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
        />
      </SettingsRow>
      <SettingsRow title={running ? t("stop") : t("start")} detail={errorText ? <span role="alert">{errorText}</span> : undefined}>
        {running ? (
          <Button disabled={busy} onClick={() => void act({ kind: "stop" })}>{t("stop")}</Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || !address}
            onClick={() => void act({ kind: "start", address, port: Number(port) || DEFAULT_PORT })}
          >
            {t("start")}
          </Button>
        )}
      </SettingsRow>

      {running && view?.origin ? (
        <>
          <SettingsRow title={t("url")} detail={<code>{view.origin}</code>}>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(view.origin!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? t("copied") : t("copy")}
            </Button>
          </SettingsRow>
          <SettingsRow
            title={t("pairing")}
            description={t("pairingHint")}
            detail={view.code ? <strong aria-live="polite">{view.code.value}</strong> : undefined}
          >
            <Button size="sm" disabled={busy} onClick={() => void act({ kind: "issueCode" })}>{t("newCode")}</Button>
          </SettingsRow>

          {view.pending.map((entry) => {
            const draft = draftFor(entry.id);
            return (
              <SettingsRow
                key={entry.id}
                title={`${t("pending")} · ${entry.label}`}
                detail={
                  <div>
                    <p>{t("pendingHint", { label: entry.label })}</p>
                    {projectOptions.length ? (
                      <CheckboxGroup
                        label={t("projects")}
                        values={draft.projectIds}
                        options={projectOptions}
                        onChange={(projectIds) => setDraft(entry.id, { projectIds })}
                      />
                    ) : (
                      <p>{t("noProjects")}</p>
                    )}
                    <Checkbox label={t("temporary")} checked={draft.temporary} onChange={(event) => setDraft(entry.id, { temporary: event.target.checked })} />
                    <Checkbox label={t("chat")} checked={draft.chat} onChange={(event) => setDraft(entry.id, { chat: event.target.checked })} />
                    <Checkbox label={t("organize")} checked={draft.organize} onChange={(event) => setDraft(entry.id, { organize: event.target.checked })} />
                  </div>
                }
              >
                <Button size="sm" disabled={busy} onClick={() => void act({ kind: "deny", id: entry.id })}>{t("deny")}</Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || (!draft.projectIds.length && !draft.temporary)}
                  onClick={() => void act({ kind: "confirm", id: entry.id, grants: draft })}
                >
                  {t("allow")}
                </Button>
              </SettingsRow>
            );
          })}

          <SettingsRow title={t("devices")} detail={view.devices.length ? undefined : t("noDevices")}>
            <span />
          </SettingsRow>
          {view.devices.map((device) => (
            <SettingsRow
              key={device.id}
              nested
              title={device.label}
              detail={`${t("scope", { count: device.grants.projectIds.length })} · ${t("lastActive", {
                time: new Date(device.lastActiveAt).toLocaleTimeString(),
              })}`}
            >
              <Button size="sm" disabled={busy} onClick={() => void act({ kind: "revoke", id: device.id })}>{t("revoke")}</Button>
            </SettingsRow>
          ))}
        </>
      ) : null}
    </SettingsCard>
  );
}
