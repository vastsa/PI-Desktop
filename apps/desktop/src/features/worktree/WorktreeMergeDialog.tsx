import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorktreeMergePreview } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { WorktreeDialogFrame } from "./WorktreeDialogFrame";
import { useWorktreeUi } from "./worktree-ui-store";
import { mergeFailureState, worktreeErrorMessage } from "./worktree-actions";

type State =
  | { phase: "loading" }
  | { phase: "ready"; preview: WorktreePreviewState }
  | { phase: "conflict"; files: string[] }
  | { phase: "failed"; message: string };

type WorktreePreviewState = WorktreeMergePreview & { notice?: string };

/**
 * "Merge into project" (PRD R4, Q10 = A): show the commits and changed files,
 * land them only after confirmation, and keep conflicts inside the session.
 */
export function WorktreeMergeDialog({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    // Reset on (re)mount: StrictMode runs this cleanup once before the real mount.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (notice?: string) => {
      setState({ phase: "loading" });
      try {
        const preview = await api.previewWorktreeMerge(sessionId);
        if (alive.current) setState({ phase: "ready", preview: { ...preview, notice } });
      } catch (error) {
        if (alive.current) setState({ phase: "failed", message: worktreeErrorMessage(error, t) });
      }
    },
    [sessionId, t],
  );
  useEffect(() => void load(), [load]);

  const merge = async (preview: WorktreeMergePreview) => {
    setBusy(true);
    try {
      const outcome = await api.mergeWorktree(sessionId, preview.previewToken);
      if (!alive.current) return;
      showToast(
        outcome.result === "merged"
          ? t("worktree.merge.success", { branch: preview.ownerBranch })
          : t("worktree.merge.nothing"),
        { variant: outcome.result === "merged" ? "success" : "info" },
      );
      void refreshSessions();
      // Other sessions of the project are now behind it.
      useWorktreeUi.getState().refreshBehind();
      onClose();
    } catch (error) {
      if (!alive.current) return;
      const failure = mergeFailureState(error, t);
      if (failure.phase === "reload") {
        await load(failure.notice);
      } else {
        setState(failure);
        // A conflict changes the session's badge.
        if (failure.phase === "conflict") void refreshSessions();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const ready = state.phase === "ready" ? state.preview : null;
  const empty = ready ? ready.commits.length === 0 && ready.files.length === 0 && !ready.conflict : false;
  const uncommitted = ready ? ready.files.some((file) => file.uncommitted) : false;

  return (
    <WorktreeDialogFrame
      id="worktree-merge"
      title={t("worktree.merge.title")}
      subtitle={title}
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {ready && !empty ? (
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              data-action="worktree-merge-confirm"
              onClick={() => void merge(ready)}
            >
              {busy ? t("worktree.merge.merging") : t("worktree.merge.confirm")}
            </Button>
          ) : null}
        </>
      }
    >
      {state.phase === "loading" ? <p>{t("common.loading")}</p> : null}
      {state.phase === "failed" ? (
        <p className="project-delete-dialog-warning" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.phase === "conflict" ? (
        <div role="alert">
          <p className="project-delete-dialog-warning">{t("worktree.merge.conflict")}</p>
          <ul className="worktree-file-list">
            {state.files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {ready ? (
        empty ? (
          <p>{t("worktree.merge.nothing")}</p>
        ) : (
          <>
            {ready.notice ? (
              <p className="project-delete-dialog-warning" role="status">
                {ready.notice}
              </p>
            ) : null}
            <p className="project-memory-dialog-description">
              {t("worktree.merge.description", {
                branch: ready.branch,
                ownerBranch: ready.ownerBranch,
              })}
            </p>
            <p data-worktree-commit-count={ready.commits.length}>
              {t("worktree.merge.commits", { count: ready.commits.length })}
            </p>
            <p data-worktree-file-count={ready.files.length}>
              {t("worktree.merge.files", { count: ready.files.length })}
            </p>
            <ul className="worktree-file-list">
              {ready.files.map((file) => (
                <li key={file.path} data-worktree-file={file.path}>
                  <code>{file.status}</code> <code>{file.path}</code>
                  {file.uncommitted ? ` · ${t("worktree.merge.uncommittedFile")}` : ""}
                </li>
              ))}
            </ul>
            {uncommitted ? (
              <p className="project-memory-dialog-hint">{t("worktree.merge.uncommittedNote")}</p>
            ) : null}
            {ready.conflict ? (
              <p className="project-memory-dialog-hint">{t("worktree.merge.resolving")}</p>
            ) : null}
          </>
        )
      ) : null}
    </WorktreeDialogFrame>
  );
}
