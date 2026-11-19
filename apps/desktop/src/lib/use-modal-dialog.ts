import { type RefObject, useEffect, useRef } from "react";
import { useBlockingOverlay } from "./blocking-overlay";

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Whether a key event belongs to this dialog rather than a layer above it. */
export function eventBelongsToDialog(
  dialog: HTMLElement | null,
  target: EventTarget | null,
  ownerDocument: Document,
): boolean {
  if (!dialog) return false;
  // Focus lost to the document body still answers to the topmost dialog.
  if (target === ownerDocument.body || target === ownerDocument.documentElement) {
    return true;
  }
  return target instanceof Node && dialog.contains(target);
}

/**
 * Modal behaviour shared by app-level dialogs (Settings, startup guide,
 * announcement): hide native plugin views beneath, move focus in, keep Tab
 * inside, close on Escape, and hand focus back on unmount.
 *
 * Escape and Tab are only claimed for events that originate inside the dialog
 * and were not already handled: a menu, recorder or nested dialog that
 * prevents the default keeps its own Escape.
 */
export function useModalDialog(
  dialogRef: RefObject<HTMLElement | null>,
  options: {
    onClose?: () => void;
    /** Element to focus first; falls back to the dialog's first focusable. */
    initialFocusRef?: RefObject<HTMLElement | null>;
  } = {},
) {
  useBlockingOverlay();
  const onCloseRef = useRef(options.onClose);
  onCloseRef.current = options.onClose;
  const initialFocusRef = options.initialFocusRef;
  // Read during the first render: child layout effects may already have moved
  // focus into the dialog by the time this hook's effect runs.
  const restoreFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  if (restoreFocusRef.current === undefined) {
    restoreFocusRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }

  useEffect(() => {
    const previouslyFocused = restoreFocusRef.current;
    const dialog = dialogRef.current;
    // Content that already placed focus inside (Settings focuses its search
    // field in a layout effect) keeps it.
    if (!dialog?.contains(document.activeElement)) {
      const initial =
        initialFocusRef?.current ?? dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
      initial?.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const current = dialogRef.current;
      if (!eventBelongsToDialog(current, event.target, document)) return;
      if (event.key === "Escape") {
        if (!onCloseRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !current) return;
      const focusable = [...current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => !node.closest("[inert]"),
      );
      if (focusable.length === 0) return;
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
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [dialogRef, initialFocusRef]);
}
