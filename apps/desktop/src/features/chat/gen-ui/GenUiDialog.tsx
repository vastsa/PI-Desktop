import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { OverlayBackdrop, portalOverlay, TooltipButton } from "../../../components/ui";
import { IconClose } from "../../../components/icons";
import { GenUiFrame } from "./GenUiFrame";
import { genUiFramePool } from "./gen-ui-frames";

/**
 * Where Tab should move focus inside the dialog, or null to let the browser
 * move it. Focus outside the dialog (e.g. after the guest frame handed it
 * back) re-enters at the first control.
 */
export function genUiDialogTabTarget<T>(focusable: readonly T[], active: unknown, backward: boolean): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!focusable.includes(active as T)) return backward ? last : first;
  if (backward && active === first) return last;
  if (!backward && active === last) return first;
  return null;
}

const FOCUSABLE = "button:not([disabled]), iframe";

/**
 * Expanded view. It loads a fresh frame for the same URL: moving the inline
 * iframe would reload it anyway, and v1 guests keep no state worth carrying.
 */
export function GenUiDialog({
  url,
  inlineSlot,
  title,
  onClose,
}: {
  url: string;
  inlineSlot: symbol;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const slot = useRef(Symbol(url));

  useLayoutEffect(() => {
    const id = slot.current;
    genUiFramePool.acquireExpanded(id, inlineSlot, onClose);
    return () => genUiFramePool.release(id);
  }, [inlineSlot, onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const target = genUiDialogTabTarget(focusable(), document.activeElement, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  // Tab inside the out-of-process guest never reaches this window, so the
  // browser moves focus past the frame. These guards catch it at the dialog
  // edges and wrap it back in.
  const wrapTo = (edge: "first" | "last") => () => {
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    (edge === "first" ? items[0] : items.at(-1))?.focus();
  };

  return portalOverlay(
    <OverlayBackdrop
      className="overlay gen-ui-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <span tabIndex={0} className="gen-ui-focus-guard" aria-hidden="true" onFocus={wrapTo("last")} />
      <div ref={dialogRef} className="dialog gen-ui-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="gen-ui-header">
          <span className="gen-ui-title">{title}</span>
          <TooltipButton
            ref={closeRef}
            type="button"
            className="icon-btn gen-ui-action"
            tooltip={t("chat.genUi.close")}
            ariaLabel={t("chat.genUi.close")}
            onClick={onClose}
          >
            <IconClose size={14} />
          </TooltipButton>
        </header>
        <div className="gen-ui-dialog-body">
          <GenUiFrame url={url} title={t("chat.genUi.frameTitle", { title })} fill onEscape={onClose} />
        </div>
      </div>
      <span tabIndex={0} className="gen-ui-focus-guard" aria-hidden="true" onFocus={wrapTo("first")} />
    </OverlayBackdrop>,
  );
}
