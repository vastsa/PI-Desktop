import { useEffect, type RefObject } from "react";

/** Keep native text selection copyable without changing pointer capture or default actions. */
export function useHoverCardSelection(
  elementRef: RefObject<HTMLElement | null>,
  keepVisible: () => void,
  scheduleHide: () => void,
  registerDismissGuard: (guard: () => boolean) => () => void,
) {
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let pointerId: number | null = null;
    let hovered = false;
    const hasSelection = () => {
      const selection = element.ownerDocument.getSelection();
      return !!selection && !selection.isCollapsed && selection.toString().length > 0
        && (element.contains(selection.anchorNode) || element.contains(selection.focusNode));
    };
    const unregister = registerDismissGuard(() => pointerId !== null || hasSelection());
    const dismissIfIdle = () => {
      if (pointerId !== null || hasSelection()) keepVisible();
      else if (!hovered && !element.contains(element.ownerDocument.activeElement)) scheduleHide();
    };
    const enter = () => { hovered = true; keepVisible(); };
    const leave = () => { hovered = false; dismissIfIdle(); };
    const press = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      pointerId = event.pointerId;
      keepVisible();
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      dismissIfIdle();
    };
    const blur = () => {
      pointerId = null;
      hovered = false;
      dismissIfIdle();
    };
    element.addEventListener("pointerdown", press);
    element.addEventListener("mouseenter", enter);
    element.addEventListener("mouseleave", leave);
    element.addEventListener("focusin", keepVisible);
    element.addEventListener("focusout", dismissIfIdle);
    // Release/cancel may occur outside the portal, or inside a child that stops bubbling.
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", blur);
    element.ownerDocument.addEventListener("selectionchange", dismissIfIdle);
    return () => {
      unregister();
      element.removeEventListener("pointerdown", press);
      element.removeEventListener("mouseenter", enter);
      element.removeEventListener("mouseleave", leave);
      element.removeEventListener("focusin", keepVisible);
      element.removeEventListener("focusout", dismissIfIdle);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", blur);
      element.ownerDocument.removeEventListener("selectionchange", dismissIfIdle);
    };
  }, [elementRef, keepVisible, scheduleHide, registerDismissGuard]);
}
