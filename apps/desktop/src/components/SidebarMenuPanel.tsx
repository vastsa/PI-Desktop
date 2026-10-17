/**
 * Shared floating menu panel for the sidebar.
 *
 * Submenus open on mouse hover and on click (including touch); keyboard users
 * open them with ArrowRight/Enter and return with ArrowLeft/Escape. The child
 * panel is viewport-positioned beside its trigger so the root menu's scroll
 * area cannot clip it.
 */
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { IconChevronRight } from "./icons";
import type {
  SidebarMenuActionItem,
  SidebarMenuGroupItem,
  SidebarMenuItem,
  SidebarMenuPanelContent,
  SidebarMenuSubmenuItem,
} from "../lib/sidebar-menu";
import { placeSidebarSubmenu } from "../lib/sidebar-menu";
const MENU_ROW_SELECTOR =
  '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';

function rowsIn(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(MENU_ROW_SELECTOR))
    .filter((row) => row.closest('[role="menu"]') === menu);
}


export function SidebarMenuPanel({
  content,
  menuRef,
  firstItemRef,
  onKeyDown,
  className,
  position,
}: {
  content: SidebarMenuPanelContent;
  menuRef?: RefObject<HTMLDivElement | null>;
  firstItemRef?: RefObject<HTMLButtonElement | null>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  className?: string;
  position: { top: number; left: number };
}) {
  const localMenuRef = useRef<HTMLDivElement>(null);
  const rootMenuRef = menuRef ?? localMenuRef;
  const submenuRef = useRef<HTMLDivElement>(null);
  const focusSubmenuOnOpen = useRef(false);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
  const openSubmenuItem = content.items.find(
    (item): item is SidebarMenuSubmenuItem =>
      item.kind === "submenu" && item.id === openSubmenuId,
  );

  const openSubmenu = useCallback((id: string, focusFirstItem: boolean) => {
    if (openSubmenuId === id) {
      if (focusFirstItem) {
        requestAnimationFrame(() => {
          if (submenuRef.current) rowsIn(submenuRef.current)[0]?.focus();
        });
      }
      return;
    }
    focusSubmenuOnOpen.current = focusFirstItem;
    setSubmenuPosition(null);
    setOpenSubmenuId(id);
  }, [openSubmenuId]);

  const closeSubmenu = useCallback((restoreFocus: boolean) => {
    const id = openSubmenuId;
    focusSubmenuOnOpen.current = false;
    setOpenSubmenuId(null);
    setSubmenuPosition(null);
    if (restoreFocus && id) {
      requestAnimationFrame(() => {
        const trigger = Array.from(
          rootMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-submenu-trigger]") ?? [],
        ).find((button) => button.dataset.submenuTrigger === id);
        trigger?.focus();
      });
    }
  }, [openSubmenuId, rootMenuRef]);

  useLayoutEffect(() => {
    if (!openSubmenuId) return;
    const reposition = () => {
      const root = rootMenuRef.current;
      const submenu = submenuRef.current;
      if (!root || !submenu) return;
      const trigger = Array.from(
        root.querySelectorAll<HTMLButtonElement>("[data-submenu-trigger]"),
      ).find((button) => button.dataset.submenuTrigger === openSubmenuId);
      if (!trigger) return;

      const triggerRect = trigger.getBoundingClientRect();
      const submenuRect = submenu.getBoundingClientRect();
      const next = placeSidebarSubmenu(
        { top: triggerRect.top, left: triggerRect.left, right: triggerRect.right },
        { width: submenuRect.width, height: submenuRect.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setSubmenuPosition((previous) =>
        previous?.left === next.left && previous.top === next.top ? previous : next,
      );
    };

    reposition();
    if (typeof ResizeObserver === "undefined" || !submenuRef.current) return;
    const observer = new ResizeObserver(reposition);
    observer.observe(submenuRef.current);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [openSubmenuId, rootMenuRef]);

  useLayoutEffect(() => {
    if (!openSubmenuId || !submenuPosition || !focusSubmenuOnOpen.current) return;
    focusSubmenuOnOpen.current = false;
    const frame = requestAnimationFrame(() => {
      const submenu = submenuRef.current;
      if (submenu) rowsIn(submenu)[0]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [openSubmenuId, submenuPosition]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const activeMenu = target?.closest<HTMLElement>('[role="menu"]') ?? rootMenuRef.current;
    const isSubmenu = activeMenu !== rootMenuRef.current;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (isSubmenu) closeSubmenu(true);
      else onKeyDown(event);
      return;
    }
    if (event.key === "ArrowLeft" && isSubmenu) {
      event.preventDefault();
      closeSubmenu(true);
      return;
    }
    if (event.key === "ArrowRight") {
      const trigger = target?.closest<HTMLButtonElement>("[data-submenu-trigger]");
      if (trigger?.dataset.submenuTrigger) {
        event.preventDefault();
        openSubmenu(trigger.dataset.submenuTrigger, true);
        return;
      }
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !activeMenu) {
      return;
    }

    const rows = rowsIn(activeMenu);
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const renderAction = (
    item: SidebarMenuActionItem,
    options?: { keyPrefix?: string; inSubmenu?: boolean },
  ) => (
    <Fragment key={`${options?.keyPrefix ?? ""}${item.id}`}>
      {item.separatorBefore ? <div className="sidebar-menu-separator" role="separator" /> : null}
      <button
        ref={options?.inSubmenu ? undefined : takeFirstItemRef()}
        type="button"
        role="menuitem"
        className={item.danger ? "danger" : undefined}
        data-action={item.id}
        data-armed={item.armed ? "true" : undefined}
        disabled={item.disabled}
        title={item.title}
        aria-busy={item.busy || undefined}
        aria-describedby={item.describedBy}
        onPointerEnter={(event) => {
          if (!options?.inSubmenu && event.pointerType === "mouse") closeSubmenu(false);
        }}
        onClick={item.onSelect}
      >
        {item.icon ?? null}
        <span className="sidebar-menu-label">{item.label}</span>
      </button>
      {item.describedBy && item.title ? (
        <p id={item.describedBy} className="sidebar-menu-hint">{item.title}</p>
      ) : null}
    </Fragment>
  );

  function takeFirstItemRef() {
    if (firstItemTaken.current) return undefined;
    firstItemTaken.current = true;
    return firstItemRef;
  }

  const firstItemTaken = useRef(false);
  firstItemTaken.current = false;

  const renderItem = (item: SidebarMenuItem) => {
    if (item.kind === "section") {
      return (
        <Fragment key={item.id}>
          <div className="sidebar-menu-separator" role="separator" />
          <p className="sidebar-menu-section" data-sidebar-menu-section={item.id}>{item.label}</p>
        </Fragment>
      );
    }
    if (item.kind === "check") {
      return (
        <button
          key={item.id}
          ref={takeFirstItemRef()}
          type="button"
          role="menuitemcheckbox"
          aria-checked={item.checked}
          data-action={item.id}
          onPointerEnter={(event) => event.pointerType === "mouse" && closeSubmenu(false)}
          onClick={item.onSelect}
        >
          <span className="sidebar-menu-label">{item.label}</span>
          <span className={`sidebar-checkbox ${item.checked ? "checked" : ""}`} aria-hidden>
            {item.checked ? "✓" : ""}
          </span>
        </button>
      );
    }
    if (item.kind === "submenu") {
      const expanded = openSubmenuId === item.id;
      return (
        <button
          key={item.id}
          ref={takeFirstItemRef()}
          type="button"
          role="menuitem"
          className={`sidebar-menu-submenu-trigger${expanded ? " is-expanded" : ""}`}
          data-submenu-trigger={item.id}
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-controls={`sidebar-submenu-${item.id}`}
          onPointerEnter={(event: ReactPointerEvent<HTMLButtonElement>) => {
            if (event.pointerType === "mouse") openSubmenu(item.id, false);
          }}
          onClick={(event) => openSubmenu(item.id, event.detail === 0)}
        >
          {item.icon ?? null}
          <span className="sidebar-menu-label">{item.label}</span>
          <IconChevronRight size={13} className="sidebar-menu-submenu-chevron" aria-hidden />
        </button>
      );
    }
    if (item.kind === "group") {
      const titled = Boolean(item.label);
      return (
        <Fragment key={item.id}>
          {titled ? (
            <>
              <div className="sidebar-menu-separator" role="separator" />
              <p className="sidebar-menu-section" data-sidebar-menu-section={item.id}>{item.label}</p>
            </>
          ) : null}
          {item.options.map((option) => (
            <button
              key={`${item.id}-${option.id}`}
              ref={takeFirstItemRef()}
              type="button"
              role="menuitemradio"
              className={option.selected ? "selected" : undefined}
              aria-checked={option.selected}
              data-action={option.id}
              onPointerEnter={(event) => event.pointerType === "mouse" && closeSubmenu(false)}
              onClick={option.onSelect}
            >
              <span className="sidebar-menu-label">{option.label}</span>
              {option.selected ? <span className="sidebar-sort-check" aria-hidden>✓</span> : null}
            </button>
          ))}
        </Fragment>
      );
    }
    return renderAction(item);
  };

  return (
    <div
      ref={rootMenuRef}
      className={className ? `sidebar-row-menu sidebar-floating-menu ${className}` : "sidebar-row-menu sidebar-floating-menu"}
      role="menu"
      aria-label={content.label}
      onKeyDown={handleKeyDown}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        closeSubmenu(false);
      }}
      style={{ top: position.top, left: position.left }}
    >
      {content.hint ? <p className="sidebar-menu-hint">{content.hint}</p> : null}
      {content.items.map(renderItem)}
      {content.notes?.map((note) => (
        <Fragment key={note.id}>
          {note.separatorBefore ? <div className="sidebar-menu-separator" role="separator" /> : null}
          <p className="sidebar-menu-note" data-sidebar-menu-note={note.id}>{note.text}</p>
        </Fragment>
      ))}
      {openSubmenuItem ? (
        <div
          ref={submenuRef}
          id={`sidebar-submenu-${openSubmenuItem.id}`}
          className="sidebar-row-menu sidebar-submenu"
          role="menu"
          aria-label={openSubmenuItem.label}
          style={submenuPosition
            ? { top: submenuPosition.top, left: submenuPosition.left }
            : { top: -10000, left: -10000, visibility: "hidden" }}
        >
          {openSubmenuItem.items.map((item) => renderAction(item, {
            keyPrefix: `${openSubmenuItem.id}-`,
            inSubmenu: true,
          }))}
          {openSubmenuItem.notes?.map((note) => (
            <Fragment key={note.id}>
              {note.separatorBefore ? <div className="sidebar-menu-separator" role="separator" /> : null}
              <p className="sidebar-menu-note" data-sidebar-menu-note={note.id}>{note.text}</p>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Closes the top-level sidebar menu and restores its trigger focus. */
export function sidebarMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  onClose: (restoreFocus?: boolean) => void,
) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  onClose();
}
