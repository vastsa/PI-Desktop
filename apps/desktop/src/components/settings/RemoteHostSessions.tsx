import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { type RemoteHostSummary, type SessionSummary } from "@pi-desktop/shared";
import { createRemoteHostWorkflow } from "../../lib/remote-host-workflow";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";

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
  const workflow = useMemo(() => createRemoteHostWorkflow(host, selectRemoteSession), [host]);
  const view = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
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

      </div>
    </section>
  );
}
