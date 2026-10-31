import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconClose } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";

/**
 * Modal frame shared by the worktree dialogs: blocking overlay, Esc to close,
 * Tab kept inside, focus restored on close. Same markup and classes as the
 * project dialogs so it inherits their styling.
 */
export function WorktreeDialogFrame({
  id,
  title,
  subtitle,
  busy = false,
  onClose,
  children,
  actions,
}: {
  id: string;
  title: string;
  subtitle?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => dialogRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), textarea:not([disabled])",
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
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

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
        className="dialog project-instructions-dialog worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        data-worktree-dialog={id}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-instructions-dialog-head">
          <div>
            <h2 id={`${id}-title`} className="project-instructions-dialog-title">
              {title}
            </h2>
            {subtitle ? (
              <div className="project-instructions-dialog-project">{subtitle}</div>
            ) : null}
          </div>
          <TooltipButton
            type="button"
            className="project-instructions-dialog-close"
            tooltip={t("common.close")}
            ariaLabel={t("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <div className="worktree-dialog-body">{children}</div>
        <div className="project-instructions-dialog-actions">{actions}</div>
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
