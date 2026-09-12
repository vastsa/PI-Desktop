import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MAX_SESSION_TITLE_LENGTH } from "@pi-desktop/shared";
import type { SessionSummary } from "@pi-desktop/shared";
import { TooltipButton } from "./ui";
import { MAX_PROJECT_NAME_CHARS } from "../lib/sidebar-preferences";
import { Button } from "./ui";
import { IconClose, IconPencil } from "./icons";

type RenameDialogProps = {
  value: string;
  title: string;
  description: string;
  label: string;
  hint: string;
  cancelLabel: string;
  saveLabel: string;
  savingLabel: string;
  maxLength: number;
  inputId: string;
  dialogId: string;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
  onError: (error: unknown) => void;
};

function RenameDialog({
  value,
  title,
  description,
  label,
  hint,
  cancelLabel,
  saveLabel,
  savingLabel,
  maxLength,
  inputId,
  dialogId,
  onClose,
  onSave,
  onError,
}: RenameDialogProps) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!savingRef.current) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled])',
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

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextValue = draft.trim();
    if (!nextValue || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(nextValue);
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const dialog = (
    <div
      className="overlay session-rename-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !savingRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog session-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div>
            <h2 id={`${dialogId}-title`} className="session-rename-dialog-title">
              <IconPencil size={16} aria-hidden />
              {title}
            </h2>
            <p id={`${dialogId}-description`} className="session-rename-dialog-description">
              {description}
            </p>
          </div>
          <TooltipButton
            type="button"
            className="session-rename-dialog-close"
            tooltip={cancelLabel}
            ariaLabel={cancelLabel}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <form onSubmit={(event) => void save(event)}>
          <label className="session-rename-dialog-label" htmlFor={inputId}>
            {label}
          </label>
          <input
            className="field-input"
            ref={inputRef}
            id={inputId}
            value={draft}
            onChange={(event) =>
              setDraft(Array.from(event.target.value).slice(0, maxLength).join(""))
            }
            aria-label={label}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            disabled={saving}
          />
          <div className="session-rename-dialog-meta">
            <span>{hint}</span>
            <span>
              {Array.from(draft).length}/{maxLength}
            </span>
          </div>
          <div className="session-rename-dialog-actions">
            <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant="primary" disabled={!draft.trim() || saving}>
              {saving ? savingLabel : saveLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document === "undefined"
    ? dialog
    : createPortal(dialog, document.body);
}

export function SessionRenameDialog({
  session,
  onClose,
  onSave,
  onError,
}: {
  session: Pick<SessionSummary, "id" | "title">;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  return (
    <RenameDialog
      value={session.title}
      title={t("session.renameTitle")}
      description={t("session.renameDescription")}
      label={t("session.renameLabel")}
      hint={t("session.renameHint")}
      cancelLabel={t("session.renameCancel")}
      saveLabel={t("session.renameSave")}
      savingLabel={t("session.renameSaving")}
      maxLength={MAX_SESSION_TITLE_LENGTH}
      inputId="session-rename-input"
      dialogId="session-rename-dialog"
      onClose={onClose}
      onSave={onSave}
      onError={onError}
    />
  );
}

export function ProjectRenameDialog({
  project,
  onClose,
  onSave,
  onError,
}: {
  project: { path: string; name: string };
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  return (
    <RenameDialog
      value={project.name}
      title={t("project.renameTitle")}
      description={t("project.renameDescription")}
      label={t("project.renameLabel")}
      hint={t("project.renameHint")}
      cancelLabel={t("project.renameCancel")}
      saveLabel={t("project.renameSave")}
      savingLabel={t("project.renameSaving")}
      maxLength={MAX_PROJECT_NAME_CHARS}
      inputId="project-rename-input"
      dialogId="project-rename-dialog"
      onClose={onClose}
      onSave={onSave}
      onError={onError}
    />
  );
}
