import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionRemoteRepository } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

export function WorkspacePreparationStatus({ sessionId, workspace }: { sessionId: string; workspace: SessionRemoteRepository }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = useAppStore((state) => state.deleteSession);
  const toast = useAppStore((state) => state.showToast);
  useEffect(() => {
    setDismissed(false);
  }, [sessionId, workspace.state, workspace.setup?.status]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); }
    catch (cause) { toast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
    finally { setBusy(false); }
  }
  if (workspace.state === "preparing") {
    const phase = workspace.phase ?? "queued";
    const detail = workspace.progress?.detail;
    const percent = workspace.progress?.percent !== undefined ? `${workspace.progress.percent}%` : undefined;
    const progressSuffix = detail && percent
      ? ` — ${detail} ${percent}`
      : detail
        ? ` — ${detail}`
        : percent
          ? ` ${percent}`
          : "";
    return <div className="composer-status" role="status">
      {t(`sessionTarget.preparation.${phase}`, { repository: `${workspace.repository.owner}/${workspace.repository.name}`, branch: workspace.workBranch ?? workspace.baseBranch })}
      {progressSuffix}
      {phase === "runningSetup" && workspace.setup?.logTail && (
        <details open><summary>{t("sessionTarget.preparation.showLog")}</summary><pre>{workspace.setup.logTail}</pre></details>
      )}
    </div>;
  }
  if (workspace.state === "failed") return <div className="composer-status" role="alert">
    {t("sessionTarget.preparation.failed", { message: workspace.error?.message })}
    <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.retryRemoteSessionWorkspace(sessionId))}>{t("sessionTarget.preparation.retry")}</Button>
    <Button variant="secondary" disabled={busy} onClick={() => void run(() => remove(sessionId))}>{t("sessionTarget.preparation.deleteSession")}</Button>
  </div>;
  if (workspace.state !== "ready" || workspace.setup?.status !== "failed" || dismissed) return null;
  return <div className="composer-status">
    {t("sessionTarget.preparation.setupFailed")}
    {workspace.setup.logTail && <details><summary>{t("sessionTarget.preparation.showLog")}</summary><pre>{workspace.setup.logTail}</pre></details>}
    <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.retryRemoteSessionWorkspace(sessionId))}>{t("sessionTarget.preparation.retry")}</Button>
    <Button variant="secondary" disabled={busy} onClick={() => setDismissed(true)}>{t("sessionTarget.dismiss")}</Button>
  </div>;
}
