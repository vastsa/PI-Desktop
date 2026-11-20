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
  const [pendingAction, setPendingAction] = useState<"push" | "find" | "create">();
  const [showDialog, setShowDialog] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string>();
  const [hostLabel, setHostLabel] = useState(workspace.hostLabel ?? workspace.hostKey);
  const [progress, setProgress] = useState<number>();
  const pullRequest = workspace.pullRequest;
  const busy = pendingAction !== undefined;
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

  async function run(kind: NonNullable<typeof pendingAction>, action: () => Promise<void>) {
    setPendingAction(kind);
    setError(undefined);
    try { await action(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (kind === "create") setError(message);
      else toast(message, { variant: "error" });
    } finally {
      setPendingAction(undefined);
      setProgress(undefined);
    }
  }
  async function startRequest() {
    const existing = await api.findRemoteSessionPullRequest(sessionId);
    if (existing.pullRequest) {
      await api.browserOpenExternal(existing.pullRequest.url);
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
      <Button variant="secondary" disabled={busy || !canPush} onClick={() => void run("push", async () => {
        setStatus((await api.pushRemoteSession(sessionId)).status);
      })}>{progress !== undefined ? t("sessionTarget.pushPercent", { percent: progress }) : pendingAction === "push" ? t("sessionTarget.pushing") : t("sessionTarget.push")}</Button>
      <Button variant="secondary" disabled={busy || (!pullRequest && status?.reachable === false)} onClick={() => void run("find", startRequest)}>
        {pullRequest ? t("sessionTarget.openPullRequest", { number: pullRequest.number }) : t("sessionTarget.createPullRequest")}
      </Button>
    </>}
    {showDialog && <WorktreeDialogFrame id="remote-pull-request" title={t("sessionTarget.createPullRequest")}
      subtitle={`${workspace.workBranch} → ${workspace.baseBranch}`} onClose={close} busy={busy}
      actions={<Button disabled={busy || !title.trim()} onClick={() => void run("create", async () => {
        await api.createRemoteSessionPullRequest({ sessionId, title: title.trim(), body, draft });
        close();
      })}>{t("sessionTarget.createPullRequest")}</Button>}>
      <Field label={t("sessionTarget.pullRequestTitle")}><Input value={title} maxLength={256} onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field label={t("sessionTarget.pullRequestBody")}><Textarea value={body} rows={5} onChange={(event) => setBody(event.target.value)} /></Field>
      <Checkbox label={t("sessionTarget.draftPullRequest")} checked={draft} onChange={(event) => setDraft(event.target.checked)} />
      {Boolean(status?.uncommittedFiles) && <p>{t("sessionTarget.uncommittedNote")}</p>}
      {error && <p role="alert">{error}</p>}
    </WorktreeDialogFrame>}
  </div>;
}
