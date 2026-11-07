import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, OverlayBackdrop } from "../../components/ui";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";

/** Portaled outside the measured Composer dock, with bounded scrolling and focus ownership. */
export function GoalDialog({ title, testId, onClose, returnFocus, children, closeLabel, hideHeaderClose = false }: {
  title: string;
  closeLabel?: string;
  hideHeaderClose?: boolean;
  testId: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  children: ReactNode;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement;
    const fallback = previous instanceof HTMLElement ? previous.closest(".goal-composer-connection")?.querySelector<HTMLElement>('.composer-editor[contenteditable="true"], .composer-shell textarea') : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close.current(); return;
      }
      if (event.key !== "Tab") return;
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? [])];
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else if (fallback?.isConnected) fallback.focus();
    };
  }, [returnFocus]);
  return portalToBody(<OverlayBackdrop className="overlay goal-dialog-overlay" role="presentation"
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="dialog goal-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
      <header className="goal-dialog-heading"><h2 id={titleId}>{title}</h2>
        {!hideHeaderClose ? <Button size="sm" variant="ghost" onClick={onClose}>{closeLabel ?? t("autonomousGoal.close")}</Button> : null}
      </header>
      <div className="goal-dialog-body">{children}</div>
    </div>
  </OverlayBackdrop>);
}
