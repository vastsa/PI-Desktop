import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MAX_SESSION_TITLE_LENGTH } from "@pi-desktop/shared";
import type { SessionSummary } from "@pi-desktop/shared";
import { Button } from "./ui";
import { IconClose, IconPencil } from "./icons";

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
  const [draft, setDraft] = useState(session.title);
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
    const title = draft.trim();
    if (!title || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(title);
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
        aria-labelledby="session-rename-dialog-title"
        aria-describedby="session-rename-dialog-description"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div>
            <h2 id="session-rename-dialog-title" className="session-rename-dialog-title">
              <IconPencil size={16} aria-hidden />
              {t("session.renameTitle")}
            </h2>
            <p id="session-rename-dialog-description" className="session-rename-dialog-description">
              {t("session.renameDescription")}
            </p>
          </div>
          <button
            type="button"
            className="session-rename-dialog-close"
            aria-label={t("session.renameCancel")}
            title={t("session.renameCancel")}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>
        <form onSubmit={(event) => void save(event)}>
          <label className="session-rename-dialog-label" htmlFor="session-rename-input">
            {t("session.renameLabel")}
          </label>
          <input
            className="field-input"
            ref={inputRef}
            id="session-rename-input"
            value={draft}
            onChange={(event) =>
              setDraft(Array.from(event.target.value).slice(0, MAX_SESSION_TITLE_LENGTH).join(""))
            }
            aria-label={t("session.renameLabel")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            disabled={saving}
          />
          <div className="session-rename-dialog-meta">
            <span>{t("session.renameHint")}</span>
            <span>
              {Array.from(draft).length}/{MAX_SESSION_TITLE_LENGTH}
            </span>
          </div>
          <div className="session-rename-dialog-actions">
            <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
              {t("session.renameCancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!draft.trim() || saving}>
              {saving ? t("session.renameSaving") : t("session.renameSave")}
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
