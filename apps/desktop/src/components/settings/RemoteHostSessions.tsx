import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { isSyncableProvider, type RemoteHostSummary, type SessionSummary } from "@pi-desktop/shared";
import { createRemoteHostWorkflow } from "../../lib/remote-host-workflow";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Checkbox, CheckboxGroup, Field, Input } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export async function selectRemoteSession(session: SessionSummary) {
  useAppStore.setState((state) => ({ sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)] }));
  try {
    await useAppStore.getState().selectSession(session.id);
  } catch (error) {
    // Selection leaves Settings immediately; keep failures visible in the chat shell.
    useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    throw error;
  }
}

/** Inline workbench: the Settings rail remains usable, without a nested modal. */
export function RemoteHostSessions({ host, onClose }: { host: RemoteHostSummary; onClose: () => void }) {
  const { t } = useTranslation("remote");
  const providers = useAppStore((state) => state.providers);
  const workflow = useMemo(() => createRemoteHostWorkflow(host, selectRemoteSession), [host]);
  const view = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
  const [projectId, setProjectId] = useState("");
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [setDefault, setSetDefault] = useState(true);
  const eligible = providers.filter(isSyncableProvider);
  useEffect(() => {
    void workflow.start();
    const unsubscribe = api.onSessionsChanged(() => void workflow.load());
    return () => { unsubscribe(); workflow.dispose(); };
  }, [workflow]);

  return (
    <section className="settings-card-block remote-host-workbench" aria-label={host.label} aria-busy={view.busy}>
      <div className="settings-card-heading-row">
        <h3 className="settings-card-heading">{host.label}</h3>
        <Button variant="ghost" onClick={onClose}>{t("close")}</Button>
        <Button variant="secondary" disabled={view.busy} onClick={() => void workflow.reconnect()}>{t("reconnect")}</Button>
        <Button variant="secondary" disabled={view.busy} onClick={() => void workflow.load()}>{t("refresh")}</Button>
      </div>
      {view.busy && <p role="status">{t("loading")}</p>}
      {view.error && <p role="alert">{t(view.error, { defaultValue: view.error })}</p>}
      <div className="settings-stack">
        {view.sessions.length === 0 ? <p>{t("empty")}</p> : view.sessions.map((session) => (
          <Button key={session.id} variant="ghost" disabled={view.busy} onClick={() => void workflow.open(session)}>
            {session.title} · {session.remoteWorkspaceLabel ?? t("workspace")}
          </Button>
        ))}
        <form className="settings-stack" onSubmit={(event) => { event.preventDefault(); void workflow.create({ projectId, path, title }); }}>
          <Field label={t("project")}>
            <SettingsMenuSelect label={t("project")} value={projectId} disabled={view.busy || Boolean(path.trim())}
              options={[{ id: "", label: t("selectProject") }, ...view.projects.map((project) => ({ id: project.id, label: project.label }))]}
              onChange={setProjectId} fullWidth />
          </Field>
          <Field label={t("path")}>
            <Input aria-label={t("path")} value={path} placeholder={t("pathPlaceholder")} disabled={view.busy}
              onChange={(event) => setPath(event.target.value)} />
          </Field>
          <Field label={t("title")}>
            <Input aria-label={t("title")} value={title} disabled={view.busy} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <p>{t("defaultModel")}</p>
          <Button type="submit" disabled={view.busy || (!projectId && !path.trim())}>{t("create")}</Button>
        </form>
        {host.transport === "ssh" && (
          <section className="settings-stack" aria-label={t("sync")}>
            <h3 className="settings-card-heading">{t("sync")}</h3>
            <p>{t("syncWarning", { host: host.label })}</p>
            {eligible.length === 0 ? <p>{t("noProviders")}</p> : (
              <CheckboxGroup label={t("sync")} values={selected} disabled={view.busy}
                options={eligible.map((provider) => ({ value: provider.id, label: provider.name }))}
                onChange={(ids) => { setSelected(ids); setConsent(false); }} />
            )}
            <Checkbox label={t("consent")} checked={consent} disabled={view.busy || selected.length === 0}
              onChange={(event) => setConsent(event.target.checked)} />
            <Checkbox label={t("setDefault")} checked={setDefault} disabled={view.busy}
              onChange={(event) => setSetDefault(event.target.checked)} />
            <Button disabled={view.busy || !consent || selected.length === 0}
              onClick={() => { void workflow.sync(providers, selected, consent, setDefault); setConsent(false); }}>
              {t("sync")}
            </Button>
            {view.syncResult && <p role="status">{t("syncResult", {
              imported: view.syncResult.imported.length, skipped: view.syncResult.skipped.length,
              defaultSet: t(view.syncResult.defaultSet ? "yes" : "no"),
            })}</p>}
          </section>
        )}
      </div>
    </section>
  );
}
