import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type Ref } from "react";

export type SidebarPreviewTriggerProps = Pick<HTMLAttributes<HTMLButtonElement>,
  "onPointerEnter" | "onPointerLeave" | "onKeyDown" | "aria-expanded" | "aria-controls">;

const DELAY_MS = 180;
const CHILD_OVERLAY = '.sidebar-row-menu, .sidebar-popover, .notification-popover-portaled, [role="dialog"], [role="alertdialog"]';

function focusFirstSidebarAction(sidebar: HTMLElement | null) {
  const actions = sidebar?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
  Array.from(actions ?? []).find(action => action.getClientRects().length > 0)?.focus();
}

export function useSidebarPreview(eligible: boolean, page: string, sessionId: string | null | undefined) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const sidebar = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const pointerInside = useRef(false);
  const focusInside = useRef(false);
  const focusOnOpen = useRef(false);
  const lastInsideEvent = useRef<Event | null>(null);
  const visible = eligible && open;

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const dismiss = useCallback((restoreFocus = false) => {
    cancel();
    setOpen(false);
    pointerInside.current = false;
    focusInside.current = false;
    focusOnOpen.current = false;
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus();
  }, [cancel]);
  const scheduleClose = useCallback(() => {
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      if (!pointerInside.current && !focusInside.current && !document.querySelector(CHILD_OVERLAY)) dismiss();
    }, DELAY_MS);
  }, [dismiss]);

  useEffect(() => {
    dismiss();
    return cancel;
  }, [eligible, page, sessionId, dismiss, cancel]);

  useEffect(() => {
    if (!visible) return;
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      focusFirstSidebarAction(sidebar.current);
    }
    const isTrigger = (event: Event) => event.target instanceof Element &&
      !!event.target.closest('[data-nav="toggle-sidebar"]');
    const onPointerDown = (event: PointerEvent) => {
      if (event === lastInsideEvent.current || isTrigger(event) || document.querySelector(CHILD_OVERLAY)) return;
      dismiss();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event === lastInsideEvent.current || isTrigger(event)) return;
      pointerInside.current = false;
      scheduleClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector(CHILD_OVERLAY)) {
        event.preventDefault();
        dismiss(true);
      }
    };
    const onBlur = () => {
      if (!document.querySelector(CHILD_OVERLAY)) dismiss();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      cancel();
    };
  }, [visible, cancel, dismiss, scheduleClose]);

  const triggerProps: SidebarPreviewTriggerProps = {
    "aria-expanded": visible,
    "aria-controls": visible ? "sidebar-preview" : undefined,
    onPointerEnter: (event) => {
      if (!eligible || event.pointerType === "touch") return;
      trigger.current = event.currentTarget;
      pointerInside.current = true;
      cancel();
      if (!open) timer.current = window.setTimeout(() => {
        timer.current = undefined;
        setOpen(true);
      }, DELAY_MS);
    },
    onPointerLeave: () => {
      pointerInside.current = false;
      if (open) scheduleClose(); else cancel();
    },
    onKeyDown: (event) => {
      if (!eligible || event.key !== "ArrowDown") return;
      event.preventDefault();
      trigger.current = event.currentTarget;
      focusOnOpen.current = true;
      cancel();
      setOpen(true);
      if (open) focusFirstSidebarAction(sidebar.current);
    },
  };
  const sidebarProps: HTMLAttributes<HTMLElement> & { ref: Ref<HTMLElement> } = {
    ref: sidebar,
    id: "sidebar-preview",
    onPointerEnter: () => { pointerInside.current = true; cancel(); },
    onPointerLeave: () => { pointerInside.current = false; scheduleClose(); },
    // React capture includes sidebar-owned portals, unlike DOM contains().
    onPointerMoveCapture: (event) => {
      lastInsideEvent.current = event.nativeEvent;
      pointerInside.current = true;
      cancel();
    },
    onPointerDownCapture: (event) => { lastInsideEvent.current = event.nativeEvent; cancel(); },
    onFocusCapture: () => { focusInside.current = true; cancel(); },
    onBlurCapture: () => { focusInside.current = false; scheduleClose(); },
  };
  return { open: visible, triggerProps, sidebarProps };
}
