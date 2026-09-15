/**
 * Compact comment editor for one response annotation (ADR response-annotations / D-LOCAL-response-annotations).
 *
 * Add to chat in the selection overlay and the assistant turn's annotate action
 * open it with the excerpt snapshotted when the selection was taken; the
 * composer's annotation list opens it to edit an existing comment. Saving writes
 * only the annotation's `annotation` field: nothing is sent, no session is
 * created, and the excerpt is never re-read from the DOM, so a focus change that
 * collapses the selection cannot lose it.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import type { ResponseAnnotationEditor } from "../lib/response-annotations";
import { Button, TooltipButton } from "./ui";
import { IconChat, IconClose } from "./icons";

export function ResponseAnnotationDialog() {
  const editor = useAppStore((s) => s.responseAnnotationEditor);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const saveResponseAnnotationEditor = useAppStore(
    (s) => s.saveResponseAnnotationEditor,
  );
  const closeResponseAnnotationEditor = useAppStore(
    (s) => s.closeResponseAnnotationEditor,
  );
  const owned = editor && editor.sessionId === activeSessionId ? editor : null;

  // The editor belongs to the session it was opened in: switching sessions
  // must not carry a half-written comment into another conversation, and the
  // save path must never touch another session's annotations.
  useEffect(() => {
    if (editor && editor.sessionId !== activeSessionId) {
      closeResponseAnnotationEditor();
    }
  }, [editor, activeSessionId, closeResponseAnnotationEditor]);

  if (!owned) return null;
  return (
    <CommentEditor
      // A different excerpt or annotation is a different editor: remounting
      // seeds the textarea from that annotation's own comment.
      key={`${owned.sessionId}\u0000${owned.annotationId ?? owned.text}`}
      editor={owned}
      onSave={saveResponseAnnotationEditor}
      onClose={closeResponseAnnotationEditor}
    />
  );
}

function CommentEditor({
  editor,
  onSave,
  onClose,
}: {
  editor: ResponseAnnotationEditor;
  onSave: (comment: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [comment, setComment] = useState(editor.comment);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const input = textareaRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        // The modal owns Escape, not the application's abort shortcut.
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "textarea:not([disabled]), button:not([disabled])",
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

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected && previouslyFocused !== document.body) {
        previouslyFocused.focus();
        if (document.activeElement === previouslyFocused) return;
      }
      // The floating selection pill disappears on open and never takes focus.
      document.querySelector<HTMLElement>(
        '[data-composer-dock] [contenteditable="true"]',
      )?.focus();
    };
  }, [onClose]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave(comment);
  };

  const dialog = (
    <div
      className="overlay session-rename-dialog-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="dialog session-rename-dialog response-annotation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="response-annotation-dialog-title"
        data-testid="annotation-comment-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div>
            <h2
              id="response-annotation-dialog-title"
              className="session-rename-dialog-title"
            >
              <IconChat size={16} aria-hidden />
              {t("chat.annotationCommentTitle")}
            </h2>
          </div>
          <TooltipButton
            type="button"
            className="session-rename-dialog-close"
            tooltip={t("common.cancel")}
            ariaLabel={t("common.cancel")}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <form onSubmit={submit}>
          <div className="response-annotation-quote">
            <span className="response-annotation-quote-label">
              {t("chat.annotationSelectedText")}
            </span>
            <blockquote className="response-annotation-quote-text">
              {editor.text}
            </blockquote>
          </div>
          <textarea
            ref={textareaRef}
            className="field-textarea response-annotation-comment-input"
            value={comment}
            rows={3}
            aria-label={t("chat.annotationCommentTitle")}
            placeholder={t("chat.annotationCommentPlaceholder")}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) onSave(event.currentTarget.value);
            }}
            data-testid="annotation-comment-input"
          />
          <div className="session-rename-dialog-actions">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary">
              {t("common.save")}
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
