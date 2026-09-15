import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ErrorCodes } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { Button, TooltipButton } from "./ui";
import { IconCircleAlert, IconClose, IconTrash } from "./icons";

/**
 * Second confirmation for deleting a project. The store action removes the
 * project record and its stored sessions; the folder on disk is never touched.
 */
export function ProjectDeleteDialog({
  project,
  onClose,
  onDeleted,
  onError,
}: {
  project: { name: string; path: string; sessionCount: number };
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const deleteProject = useAppStore((s) => s.deleteProject);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => dialogRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await deleteProject(project.path);
      await onDeleted();
    } catch (error) {
      // The host refuses the delete while a task of this project is running;
      // show the same localized explanation the menu guard uses.
      if ((error as { errorCode?: unknown } | null)?.errorCode === ErrorCodes.CONFLICT) {
        onError(new Error(t("project.deleteRunningBlocked")));
        return;
      }
      onError(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const dialog = (
    <div
      className="overlay project-instructions-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog project-instructions-dialog project-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-delete-dialog-title"
        aria-describedby="project-delete-dialog-description project-delete-dialog-sessions project-delete-dialog-folder-kept"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-instructions-dialog-head">
          <div>
            <h2 id="project-delete-dialog-title" className="project-instructions-dialog-title">
              <IconCircleAlert size={17} aria-hidden />
              {t("project.deleteTitle")}
            </h2>
            <div className="project-instructions-dialog-project">{project.name}</div>
          </div>
          <TooltipButton
            type="button"
            className="project-instructions-dialog-close"
            tooltip={t("project.deleteCancel")}
            ariaLabel={t("project.deleteCancel")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <div className="project-delete-dialog-body">
          <p id="project-delete-dialog-description" className="project-memory-dialog-description">
            {t("project.deleteDescription", { name: project.name })}
          </p>
          <p id="project-delete-dialog-sessions" className="project-delete-dialog-warning">
            <IconTrash size={14} aria-hidden />
            <span>{t("project.deleteSessions", { count: project.sessionCount })}</span>
          </p>
          <p id="project-delete-dialog-folder-kept" className="project-memory-dialog-hint">
            {t("project.deleteFolderKept")}
          </p>
        </div>
        <div className="project-instructions-dialog-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("project.deleteCancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="project-delete-dialog-confirm"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? t("project.deleting") : t("project.deleteConfirm")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
