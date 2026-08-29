/**
 * A trigger-anchored floating menu for settings rows.
 *
 * Settings cards clip their overflow (`.settings-panel` draws the frame with
 * `overflow: hidden`), so an anchored surface cannot be an absolutely
 * positioned child: it portals to `document.body` as a fixed layer and is
 * placed from the trigger's rect. The placement, close and reposition rules
 * follow the font picker, which solved the same problem first.
 *
 * The menu is measured before it is revealed, so `is-open` gates visibility:
 * a `visibility: hidden` surface cannot take focus, and an unmeasured one
 * would flash at the viewport origin.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;
const GAP = 6;

export type AnchoredMenuProps = {
  open: boolean;
  onClose: () => void;
  /** Rendered inside the row; receives the ref the menu anchors to. */
  trigger: (ref: React.RefObject<HTMLButtonElement | null>) => ReactNode;
  children: ReactNode;
  /** Class for the portaled surface; `is-open` is appended once measured. */
  menuClassName: string;
  label: string;
  role?: "listbox" | "menu";
  /** Extra class for the row-level wrapper that owns the trigger. */
  className?: string;
  /** Aligns the menu's right edge with the trigger's; defaults to left. */
  align?: "start" | "end";
};

export function AnchoredMenu({
  open,
  onClose,
  trigger,
  children,
  menuClassName,
  label,
  role = "listbox",
  className,
  align = "start",
}: AnchoredMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );

  useEffect(() => {
    if (!open) setPosition(null);
  }, [open]);

  /* Closing returns focus to the trigger so Tab order does not jump to <body>. */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const anchorRect = anchor.getBoundingClientRect();
    // A trigger scrolled out of the settings viewport has no sensible anchor.
    if (anchorRect.bottom <= 0 || anchorRect.top >= window.innerHeight) {
      onClose();
      return;
    }
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(MARGIN, window.innerWidth - menuRect.width - MARGIN);
    const preferredLeft =
      align === "end" ? anchorRect.right - menuRect.width : anchorRect.left;
    const left = Math.min(Math.max(MARGIN, preferredLeft), maxLeft);
    const below = anchorRect.bottom + GAP;
    const above = anchorRect.top - menuRect.height - GAP;
    const maxTop = Math.max(MARGIN, window.innerHeight - menuRect.height - MARGIN);
    const top =
      below <= maxTop
        ? Math.max(MARGIN, below)
        : above >= MARGIN
          ? above
          : Math.min(below, maxTop);
    setPosition((previous) =>
      previous && previous.top === top && previous.left === left
        ? previous
        : { top, left },
    );
  }, [align, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, children, updatePosition]);

  /*
    Move focus into the menu once it is measured and visible: a keyboard user
    who opened it would otherwise still be on the trigger, and a
    `visibility: hidden` surface cannot take focus. The current option is
    preferred so Enter re-confirms rather than silently picking the first row.
  */
  useEffect(() => {
    if (!open || !position) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      const current = menu.querySelector<HTMLElement>(
        '[aria-selected="true"]:not([disabled])',
      );
      const target =
        current ?? menu.querySelector<HTMLElement>("button:not([disabled])");
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onViewportChange = (event: Event) => {
      // Scrolling inside the menu cannot move a fixed layer, so skip it rather
      // than forcing a layout read on every scroll tick.
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      updatePosition();
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, updatePosition]);

  return (
    <div className={className} ref={rootRef}>
      {trigger(triggerRef)}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className={`${menuClassName}${position ? " is-open" : ""}`}
              role={role}
              aria-label={label}
              style={
                position
                  ? { top: `${position.top}px`, left: `${position.left}px` }
                  : undefined
              }
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
