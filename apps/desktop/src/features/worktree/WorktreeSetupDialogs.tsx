import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorktreeSetupLog } from "@pi-desktop/shared";
import { Button, Field, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { WorktreeDialogFrame } from "./WorktreeDialogFrame";

/** Per-project command run in every new isolated worktree (PRD R2a). */
export function WorktreeSetupCommandDialog({
  projectPath,
  projectName,
  onClose,
}: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [command, setCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    // Reset on (re)mount: StrictMode runs this cleanup once before the real mount.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    api
      .getWorktreeSetupCommand(projectPath)
      .then((result) => alive.current && setCommand(result.command ?? ""))
      .catch((error: unknown) => {
        if (!alive.current) return;
        setCommand("");
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      });
  }, [projectPath, showToast]);

  const save = async () => {
    setBusy(true);
    try {
      await api.setWorktreeSetupCommand(projectPath, command?.trim() ? command : null);
      showToast(t("worktree.setupCommand.saved"), { variant: "success" });
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <WorktreeDialogFrame
      id="worktree-setup-command"
      title={t("worktree.setupCommand.title")}
      subtitle={projectName}
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || command === null}
            data-action="worktree-setup-command-save"
            onClick={() => void save()}
          >
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <p className="project-memory-dialog-description">{t("worktree.setupCommand.description")}</p>
      <Field label={t("worktree.setupCommand.label")} hint={t("worktree.setupCommand.hint")}>
        <Textarea
          rows={4}
          value={command ?? ""}
          disabled={command === null || busy}
          placeholder={t("worktree.setupCommand.placeholder")}
          onChange={(event) => setCommand(event.target.value)}
        />
      </Field>
    </WorktreeDialogFrame>
  );
}

/** Output of the setup command for an isolated session (AC3). */
export function WorktreeSetupLogDialog({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [log, setLog] = useState<WorktreeSetupLog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getWorktreeSetupLog(sessionId)
      .then((result) => alive && setLog(result))
      .catch((error: unknown) => alive && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const status = log?.setupStatus;
  return (
    <WorktreeDialogFrame
      id="worktree-setup-log"
      title={t("worktree.setupLog.title")}
      subtitle={title}
      onClose={onClose}
      actions={
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      {failure ? <p role="alert">{failure}</p> : null}
      {!log && !failure ? <p>{t("common.loading")}</p> : null}
      {log ? (
        <>
          <p data-worktree-setup-status={status ?? "none"}>
            {status === "running"
              ? t("worktree.setupLog.running")
              : status === "ok"
                ? t("worktree.setupLog.ok")
                : status === "failed"
                  ? t("worktree.setupLog.failed")
                  : t("worktree.setupLog.none")}
          </p>
          {log.log ? <pre className="worktree-setup-log">{log.log}</pre> : null}
        </>
      ) : null}
    </WorktreeDialogFrame>
  );
}
