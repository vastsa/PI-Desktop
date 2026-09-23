/**
 * A pointer-anchored context menu for renderer surfaces.
 *
 * `AnchoredMenu` places a surface against a control's rect, which a right-click
 * cannot provide, so this is the pointer-anchored member of the same family. It
 * follows the same rules every other renderer-owned dropdown follows: it
 * portals to `document.body` as a viewport-fixed layer (a transformed or
 * `overflow: hidden` ancestor cannot trap it), it is measured before it is
 * revealed so it never flashes at the viewport origin, it clamps inside the
 * viewport, and it closes on an outside press, Escape, or a scroll of anything
 * behind it. `is-open` gates visibility because a `visibility: hidden` surface
 * cannot take focus.
 *
 * Menus are data, not children: `useContextMenu` owns the open request, call
 * sites hand it a label plus items, and one mounted `<ContextMenu>` renders it.
 * That keeps exactly one such surface on screen and lets a row build its items
 * where the actions already live.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { portalToBody } from "../lib/portal-visibility";
import {
  placeContextMenu,
  type ContextMenuPlacement,
  type ContextMenuPoint,
} from "../lib/context-menu";
import { texClipboardPayload } from "../lib/selection-tex";

export type ContextMenuItem = {
  /** Stable identity for React keys and for tests naming a row. */
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Destructive item: error ink, and never adjacent to what it undoes. */
  danger?: boolean;
  /** Hairline above this item, splitting the menu into groups. */
  separatorBefore?: boolean;
  onSelect: (selection: string) => void;
};

export type ContextMenuRequest = {
  /**
   * Accessible name for the surface, e.g. "Message actions". Optional because a
   * menu whose items already name their target (a link's own actions) reads
   * correctly unnamed; an unnamed *and* ambiguous menu is the caller's bug.
   */
  label?: string;
  items: ContextMenuItem[];
};

export type ContextMenuState = ContextMenuRequest & {
  /** Where the pointer asked for the surface. */
  point: ContextMenuPoint;
  /** Live selection at open time; empty when the caret was collapsed. */
  selection: string;
};

/**
 * Keyboard-opened menus (Shift+F10, the context-menu key) report no pointer
 * coordinates, so they anchor near the focused node instead of the origin.
 */
function pointForEvent(event: ReactMouseEvent<HTMLElement>): ContextMenuPoint {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: rect.left + Math.min(24, rect.width / 2),
    y: rect.top + Math.min(24, rect.height / 2),
  };
}

/**
 * A selection in the composer or another row is not "this turn's excerpt".
 * Anchor or focus inside the right-clicked node is enough: a range that
 * starts in this row still belongs to Copy here.
 *
 * `useCopyTex` has no counterpart to this check, and the asymmetry is the
 * point: `root` is where the *user* aimed the pointer, which really can be a
 * row the selection never entered, while a `copy` event's target is derived
 * by the platform from the selection itself and so is always inside it. Do
 * not mirror this gate onto the copy listener — it rejects every range built
 * with `selectNodeContents`, this row's Copy item included.
 */
function snapshotSelection(root: EventTarget): string {
  // Textarea ranges are not represented by the document Selection.
  const editor = document.activeElement;
  if (
    root instanceof Node &&
    editor instanceof HTMLTextAreaElement &&
    root.contains(editor)
  ) {
    return editor.value.slice(editor.selectionStart, editor.selectionEnd);
  }
  const live = window.getSelection();
  if (!live || live.rangeCount === 0 || live.isCollapsed) return "";
  if (!(root instanceof Node)) return "";
  const { anchorNode, focusNode } = live;
  const inside =
    (anchorNode && root.contains(anchorNode)) ||
    (focusNode && root.contains(focusNode));
  if (!inside) return "";
  /*
    A formula reads as its TeX source here too: Copy and Ctrl+C must not put
    two different readings of the same selection on the clipboard (issue #414).
    Read after the row check, so a selection this row does not own is never
    serialized at all.

    Read *here*, while the menu is opening, and not from the Copy item's own
    `onSelect`, even though that would reduce only when the user asks for it.
    The menu focuses its first item a frame after it opens (the
    `requestAnimationFrame` in `ContextMenu` below) and that collapses the
    range, so by the time an item runs there is no selection left to read.
    Deferring would mean carrying a cloned `Range` across the gap, where it
    goes stale while a turn is still streaming — a new failure mode traded for
    one clone. That clone is bounded by `mayContainKatex`, so only a row that
    actually renders math pays for it, and it is paid inside the frame the
    menu already spends before it can take focus. Menus whose items ignore the
    selection (a link's, in `Markdown.tsx`) pay it too; an opt-in flag on
    `ContextMenuRequest` would spare them and is not worth the public field.

    Read without a `try`/`catch`, deliberately. The only fallback a catch
    could reach for is the `live.toString()` below, which is the duplicated
    glyph reading issue #414 exists about — so swallowing here would turn a
    defect in the reduction into a silently wrong clipboard, the one outcome
    this module was written to remove. `markdown-blocks.ts` degrades rather
    than throwing for the opposite reason, not the same one: it runs in a
    render memo under the app's single root `ErrorBoundary`, where a throw
    replaces the whole window.

    The price here is smaller but it is not nothing, and naming it is the
    point: `openContextMenu` has already called `preventDefault` by the time
    this runs and has not called `setState` yet, so a throw costs the user
    this one right-click — no menu of ours, and no platform menu behind it
    either, since nothing registers `webContents.on("context-menu")`. Paid
    knowingly. A silently wrong clipboard is the failure that outlives the
    gesture; a menu that has to be opened twice is not. Reordering the
    snapshot above `preventDefault` would not buy a fallback back, only move
    which nothing happens.
  */
  return texClipboardPayload(live) ?? live.toString();
}

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setState(null), []);
  /*
    Every caller wants the same two effects: the platform's own menu must not
    also appear, and an ancestor surface must not react to the same right-click.
    Both are applied here so no call site can forget one.
  */
  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, request: ContextMenuRequest) => {
      if (!request.items.length) return;
      event.preventDefault();
      event.stopPropagation();
      /*
        Snapshot the live selection before the menu takes focus: focusing a
        menuitem collapses the range, and Copy would then only see the whole
        turn. A collapsed caret, or a selection that lives outside this
        target, is stored as empty so Copy still falls back.
      */
      const selection = snapshotSelection(event.currentTarget);
      setState({ ...request, point: pointForEvent(event), selection });
    },
    [],
  );
  return { contextMenu: state, openContextMenu, closeContextMenu };
}

export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ContextMenuPlacement | null>(null);

  const measure = useCallback(
    (request: ContextMenuState) => {
      const menu = menuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const next = placeContextMenu(
        request.point,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPlacement((previous) =>
        previous && previous.top === next.top && previous.left === next.left
          ? previous
          : next,
      );
    },
    [],
  );

  // A menu that is not on screen owns no placement; the closed surface is
  // unmounted, so the next one starts over from its own measurement.
  useEffect(() => {
    if (!state) setPlacement(null);
  }, [state]);

  /*
    Measured in a layout effect so the reveal and the final position land in the
    same paint: a deferred measurement would show the surface at the viewport
    origin for one frame.
  */
  useLayoutEffect(() => {
    if (state) measure(state);
  }, [measure, state]);

  // Content that resizes after reveal (a longer label, a late font) is
  // re-clamped rather than left hanging past the edge.
  useEffect(() => {
    if (!state || typeof ResizeObserver === "undefined") return;
    const menu = menuRef.current;
    if (!menu) return;
    const observer = new ResizeObserver(() => measure(state));
    observer.observe(menu);
    return () => observer.disconnect();
  }, [measure, state]);

  /*
    Focus leaves the transcript while a menu is up and returns to whatever the
    right-click interrupted, so closing never strands focus on `<body>`.
  */
  useEffect(() => {
    if (!state) return;
    const interrupted =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      if (interrupted?.isConnected) interrupted.focus();
    };
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const menu = menuRef.current;
    /*
      Capture phase on purpose: a nested surface that stops propagation on its
      own press would otherwise leave this menu open behind it.
    */
    const onOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menu?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stop so a surrounding overlay does not also close on this Escape.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("contextmenu", onOutside, true);
    window.addEventListener("scroll", onOutside, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("contextmenu", onOutside, true);
      window.removeEventListener("scroll", onOutside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose, state]);

  // Keyboard users land on the first item; Enter then runs it instead of
  // re-opening the menu.
  useEffect(() => {
    if (!state || !placement) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [placement, state]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Tab leaves the menu rather than walking its items.
    if (event.key === "Tab") {
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  if (!state || typeof document === "undefined") return null;

  return portalToBody(
    <div
      ref={menuRef}
      className={`context-menu${placement ? " is-open" : ""}`}
      role="menu"
      aria-label={state.label}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={
        placement
          ? { top: `${placement.top}px`, left: `${placement.left}px` }
          : undefined
      }
    >
      {state.items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore && index > 0 ? (
            <div className="context-menu-separator" role="separator" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? " danger" : ""}`}
            data-context-menu-item={item.id}
            disabled={item.disabled}
            onClick={() => {
              // Close first: an item that opens a dialog must not leave a menu
              // layered over it.
              onClose();
              item.onSelect(state.selection);
            }}
          >
            {item.icon ? (
              <span className="context-menu-icon" aria-hidden>
                {item.icon}
              </span>
            ) : null}
            <span className="context-menu-label">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
  );
}
