/**
 * Chromium can keep `:hover` on a message after the pointer leaves the
 * window, so hover-only chrome (timestamps, copy chips) stays painted.
 * Mark `<html>` when the pointer is outside; CSS then hides that chrome.
 *
 * `mouseleave` on `<html>` is not enough on Electron/Windows: the event
 * is often skipped while `:hover` remains. `mouseout` with a null
 * `relatedTarget` is the signal that the pointer left the document.
 */

export const POINTER_OUTSIDE_CLASS = "pointer-outside";

interface ClassListLike {
  contains(name: string): boolean;
  add(name: string): void;
  remove(name: string): void;
}

type PointerOutsideListener = (event?: Event) => void;

interface ViewLike {
  addEventListener(type: string, listener: PointerOutsideListener): void;
  removeEventListener(type: string, listener: PointerOutsideListener): void;
}

export interface PointerOutsideRoot {
  hidden?: boolean;
  documentElement: {
    classList: ClassListLike;
  };
  defaultView?: ViewLike | null;
  addEventListener(type: string, listener: PointerOutsideListener): void;
  removeEventListener(type: string, listener: PointerOutsideListener): void;
}

function leftTheWindow(event?: Event): boolean {
  if (event == null) return true;
  const mouse = event as Event & {
    relatedTarget?: EventTarget | null;
    toElement?: EventTarget | null;
  };
  return mouse.relatedTarget == null && mouse.toElement == null;
}

export function installPointerOutside(root: PointerOutsideRoot): () => void {
  const html = root.documentElement;
  const leave = () => {
    if (!html.classList.contains(POINTER_OUTSIDE_CLASS)) {
      html.classList.add(POINTER_OUTSIDE_CLASS);
    }
  };
  const enter = () => {
    if (html.classList.contains(POINTER_OUTSIDE_CLASS)) {
      html.classList.remove(POINTER_OUTSIDE_CLASS);
    }
  };
  const onVisibility = () => {
    if (root.hidden) leave();
  };
  const onMouseOut = (event?: Event) => {
    if (!leftTheWindow(event)) return;
    leave();
  };
  const view = root.defaultView;
  root.addEventListener("mouseout", onMouseOut);
  root.addEventListener("mouseover", enter);
  root.addEventListener("mouseleave", leave);
  root.addEventListener("mouseenter", enter);
  root.addEventListener("pointerleave", leave);
  root.addEventListener("pointerenter", enter);
  view?.addEventListener("blur", leave);
  root.addEventListener("visibilitychange", onVisibility);
  return () => {
    root.removeEventListener("mouseout", onMouseOut);
    root.removeEventListener("mouseover", enter);
    root.removeEventListener("mouseleave", leave);
    root.removeEventListener("mouseenter", enter);
    root.removeEventListener("pointerleave", leave);
    root.removeEventListener("pointerenter", enter);
    view?.removeEventListener("blur", leave);
    root.removeEventListener("visibilitychange", onVisibility);
    enter();
  };
}
