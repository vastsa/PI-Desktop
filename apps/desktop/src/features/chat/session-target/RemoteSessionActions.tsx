import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteSessionGitStatus, SessionRemoteRepository } from "@pi-desktop/shared";
import { Button, Checkbox, Field, Input, Textarea } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { WorktreeDialogFrame } from "../../worktree/WorktreeDialogFrame";

export function RemoteSessionActions({ sessionId, sessionTitle, workspace }: { sessionId: string; sessionTitle: string; workspace: SessionRemoteRepository }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteSessionGitStatus>();
  const [busy, setBusy] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string>();
  const [hostLabel, setHostLabel] = useState(workspace.hostLabel ?? workspace.hostKey);
  const [progress, setProgress] = useState<number>();
  const [pullRequest, setPullRequest] = useState(workspace.pullRequest);
  const toast = useAppStore((state) => state.showToast);
  const close = useCallback(() => setShowDialog(false), []);
  const ready = workspace.state === "ready";
  const canPush = status?.reachable === true
    && (Boolean(status.unpushedCommits) || Boolean(status.ahead) || !status.pushedOnce && Boolean(status.aheadOfBase));
  useEffect(() => {
    let current = true;
    void api.listRemoteHosts().then(({ hosts }) => {
      if (current) setHostLabel(hosts.find((host) => host.hostKey === workspace.hostKey)?.label ?? workspace.hostKey);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [workspace.hostKey]);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    const refresh = () => void api.remoteSessionGitStatus(sessionId).then(
      (next) => { if (current) setStatus(next.status); },
      () => { if (current) setStatus(undefined); },
    );
    refresh();
    window.addEventListener("focus", refresh);
    const offHosts = api.onSessionsChanged((event) => { if (event.reason === "remote.host.changed") refresh(); });
    const offTurns = api.onAgentEvent((event) => { if (event.sessionId === sessionId && event.event.type === "agent_end") refresh(); });
    const offProgress = api.onRemoteSessionPushProgress((event) => {
      if (event.sessionId === sessionId) setProgress(event.progress?.percent);
    });
    return () => { current = false; window.removeEventListener("focus", refresh); offHosts(); offTurns(); offProgress(); };
  }, [ready, sessionId]);
  useEffect(() => { setPullRequest(workspace.pullRequest); }, [workspace.pullRequest]);

  async function run(action: () => Promise<void>, inDialog = false) {
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (inDialog) setError(message);
      else toast(message, { variant: "error" });
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  }
  async function startRequest() {
    const existing = await api.findRemoteSessionPullRequest(sessionId);
    if (existing.pullRequest) {
      setPullRequest(existing.pullRequest);
      return;
    }
    setTitle(sessionTitle);
    setShowDialog(true);
  }
  return <div className="session-target-row">
    <span title={hostLabel}>
      {`${hostLabel} · ${workspace.repository.owner}/${workspace.repository.name}`}{workspace.workBranch ? ` · ${workspace.workBranch}` : ""}
    </span>
    {ready && <>
      {status?.reachable === false && <span>{t("sessionTarget.offline")}</span>}
      {status?.reachable && (Boolean(status.ahead) || Boolean(status.behind) || Boolean(status.uncommittedFiles)) &&
        <span>{t("sessionTarget.gitCounts", { ahead: status.ahead ?? 0, behind: status.behind ?? 0, files: status.uncommittedFiles ?? 0 })}</span>}
      <Button variant="secondary" disabled={busy || !canPush} onClick={() => void run(async () => {
        setStatus((await api.pushRemoteSession(sessionId)).status);
      })}>{progress !== undefined ? t("sessionTarget.pushPercent", { percent: progress }) : busy && !showDialog ? t("sessionTarget.pushing") : t("sessionTarget.push")}</Button>
      {pullRequest ? <Button variant="secondary" onClick={() => void api.browserOpenExternal(pullRequest.url)}>
        {t("sessionTarget.openPullRequest", { number: pullRequest.number })}
      </Button> : <Button variant="secondary" disabled={busy || status?.reachable === false} onClick={() => void run(startRequest)}>
        {t("sessionTarget.createPullRequest")}
      </Button>}
    </>}
    {showDialog && <WorktreeDialogFrame id="remote-pull-request" title={t("sessionTarget.createPullRequest")}
      subtitle={`${workspace.workBranch} → ${workspace.baseBranch}`} onClose={close} busy={busy}
      actions={<Button disabled={busy || !title.trim()} onClick={() => void run(async () => {
        const result = await api.createRemoteSessionPullRequest({ sessionId, title: title.trim(), body, draft });
        setPullRequest(result.pullRequest);
        close();
      }, true)}>{t("sessionTarget.createPullRequest")}</Button>}>
      <Field label={t("sessionTarget.pullRequestTitle")}><Input value={title} maxLength={256} onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field label={t("sessionTarget.pullRequestBody")}><Textarea value={body} rows={5} onChange={(event) => setBody(event.target.value)} /></Field>
      <Checkbox label={t("sessionTarget.draftPullRequest")} checked={draft} onChange={(event) => setDraft(event.target.checked)} />
      {Boolean(status?.uncommittedFiles) && <p>{t("sessionTarget.uncommittedNote")}</p>}
      {error && <p role="alert">{error}</p>}
    </WorktreeDialogFrame>}
  </div>;
}
