import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { remoteHostErrorKey } from "../../lib/remote-host-errors";
import { Button, Field, Input, Select } from "../ui";
import { RemoteFolderDialog } from "./RemoteFolderDialog";

export type RemoteProjectSelection = { hostKey: string; hostLabel: string; path: string };

export function RemoteProjectPicker({ busy, initialHostKey, onChange, onBrowsingChange }: {
  busy: boolean;
  initialHostKey?: string;
  onChange: (selection: RemoteProjectSelection | null) => void;
  onBrowsingChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [hostKey, setHostKey] = useState(initialHostKey ?? "");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [error, setError] = useState("");
  const selectionCallback = useRef(onChange);
  selectionCallback.current = onChange;
  const browsingCallback = useRef(onBrowsingChange);
  browsingCallback.current = onBrowsingChange;
  const host = hosts.find((item) => item.hostKey === hostKey);

  useEffect(() => {
    let active = true;
    void api.listRemoteHosts().then(({ hosts }) => {
      if (!active) return;
      setHosts(hosts);
      setHostKey(hosts.find((host) => host.hostKey === initialHostKey)?.hostKey ?? hosts.find((host) => host.connected)?.hostKey ?? hosts[0]?.hostKey ?? "");
    }).catch((error: unknown) => {
      if (active) setError(t(remoteHostErrorKey(error)));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; selectionCallback.current(null); browsingCallback.current(false); };
  }, [initialHostKey, t]);

  useEffect(() => {
    selectionCallback.current(host && path.trim().startsWith("/") ? { hostKey, hostLabel: host.label, path: path.trim() } : null);
  }, [host, hostKey, path]);

  const setBrowsing = (open: boolean) => { setBrowseOpen(open); browsingCallback.current(open); };
  return <section className="project-create-dialog-section remote-project-picker" aria-busy={loading}>
    <Field label={t("remote:projectHost")}>
      <Select aria-label={t("remote:projectHost")} value={hostKey} disabled={busy || loading} onChange={(event) => {
        selectionCallback.current(null); setPath(""); setHostKey(event.target.value); setBrowsing(false);
      }}>
        {!hosts.length ? <option value="">{t("remote:noConnectedHosts")}</option> : null}
        {hosts.map((host) => <option key={host.hostKey} value={host.hostKey}>{host.connected ? host.label : t("remote:offlineHost", { label: host.label })}</option>)}
      </Select>
    </Field>
    {host ? <>
      {!host.connected ? <p role="status">{t("remote:reconnectOnUse")}</p> : null}
      <Field label={t("remote:projectFolder")}>
        <div className="remote-folder-dialog-path-entry">
          <Input value={path} aria-label={t("remote:projectFolder")} placeholder={t("remote:pathPlaceholder")} disabled={busy}
            autoComplete="off" spellCheck={false} onChange={(event) => setPath(event.target.value)} />
          <Button type="button" disabled={busy} onClick={(event) => { event.currentTarget.focus(); setBrowsing(true); }}>{t("remote:browseFolders")}</Button>
        </div>
      </Field>
      {path && !path.trim().startsWith("/") ? <p className="remote-project-error" role="alert">{t("remote:REMOTE_ABSOLUTE_PATH_REQUIRED")}</p> : null}
    </> : null}
    {loading ? <p role="status">{t("remote:loading")}</p> : null}
    {error ? <p className="remote-project-error" role="alert">{error}</p> : null}
    {browseOpen && host ? <RemoteFolderDialog key={hostKey} hostKey={hostKey} hostLabel={host.label} initialPath={path}
      onChoose={(selected) => { setPath(selected); setBrowsing(false); }} onClose={() => setBrowsing(false)} /> : null}
  </section>;
}
