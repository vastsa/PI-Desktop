import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { Button, TooltipButton } from "./ui";
import { IconCircleAlert, IconClose } from "./icons";

export function SessionDeleteDialog({
  session,
  onClose,
  onDelete,
  onError,
}: {
  session: Pick<SessionSummary, "id" | "title">;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());

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
      cancelAnimationFrame(frame);
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
      await onDelete();
    } catch (error) {
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
        aria-labelledby="session-delete-dialog-title"
        aria-describedby="session-delete-dialog-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-instructions-dialog-head">
          <div>
            <h2 id="session-delete-dialog-title" className="project-instructions-dialog-title">
              <IconCircleAlert size={17} aria-hidden />
              {t("session.deleteTitle")}
            </h2>
            <div className="project-instructions-dialog-project">{session.title}</div>
          </div>
          <TooltipButton
            type="button"
            className="project-instructions-dialog-close"
            tooltip={t("session.deleteCancel")}
            ariaLabel={t("session.deleteCancel")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <div className="project-delete-dialog-body">
          <p id="session-delete-dialog-description" className="project-memory-dialog-description">
            {t("session.deleteDescription", { name: session.title })}
          </p>
        </div>
        <div className="project-instructions-dialog-actions">
          <Button ref={cancelRef} type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("session.deleteCancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="project-delete-dialog-confirm"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? t("session.deleting") : t("session.deleteConfirm")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
