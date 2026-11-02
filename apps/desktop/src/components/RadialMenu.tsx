/**
 * The radial menu a right-click opens on the empty transcript background.
 *
 * Four wedges, one action each, keyed by the pointer's direction from the
 * click point. Every wedge carries its icon and label at rest, so the ring is
 * readable without hovering; the wedge under the pointer or keyboard focus
 * fills, and the hub stays a recessed center the click point sits in. It is
 * not a replacement for `ContextMenu`: the list stays the menu for rows,
 * links, and file references, where the item count varies per target. This
 * surface only renders when the user opts in through `AppSettings.radialMenu`,
 * and it keeps the same floating-layer contract — viewport-fixed portal,
 * measured before reveal, clamped inside the window, Escape and outside-press
 * dismissal, and keyboard reachability. The standard marking gesture works
 * too: a right-press started while the ring is open runs the wedge it is
 * released on, and releasing in the hub dismisses without running.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { portalToBody } from "../lib/portal-visibility";
import { CONTEXT_MENU_MARGIN, type ContextMenuPoint } from "../lib/context-menu";

export type RadialMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};
/** A slot the current conversation cannot fill keeps its sector and does not run. */
export type RadialMenuSlot = RadialMenuItem & { disabled?: boolean };

/** Ring geometry, in CSS px. The four item slots sit on the ring's mid-line. */
const OUTER_RADIUS = 124;
const INNER_RADIUS = 40;
/** Distance from the center to the middle of an item's icon-and-label stack. */
const CONTENT_RADIUS = 85;
const ITEM_WIDTH = 100;
const ITEM_HEIGHT = 56;

/** Clockwise from the top; matches `RADIAL_MENU_DIRECTIONS`. */
const ITEM_ANGLES = [-90, 0, 90, 180] as const;
const WEDGE_ANGLES = [
  [-135, -45],
  [-45, 45],
  [45, 135],
  [135, 225],
] as const;

const rad = (degrees: number) => (degrees * Math.PI) / 180;

function wedgePath(startAngle: number, endAngle: number): string {
  const center = OUTER_RADIUS;
  const at = (radius: number, angle: number) => [
    center + radius * Math.cos(rad(angle)),
    center + radius * Math.sin(rad(angle)),
  ];
  const [innerStartX, innerStartY] = at(INNER_RADIUS, startAngle);
  const [outerStartX, outerStartY] = at(OUTER_RADIUS, startAngle);
  const [outerEndX, outerEndY] = at(OUTER_RADIUS, endAngle);
  const [innerEndX, innerEndY] = at(INNER_RADIUS, endAngle);
  return [
    `M ${innerStartX} ${innerStartY}`,
    `L ${outerStartX} ${outerStartY}`,
    `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 0 1 ${outerEndX} ${outerEndY}`,
    `L ${innerEndX} ${innerEndY}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 0 0 ${innerStartX} ${innerStartY}`,
    "Z",
  ].join(" ");
}

/** Which slot the pointer is over, or null in the hub, the margin, or outside. */
function slotAt(offsetX: number, offsetY: number): number | null {
  const distance = Math.hypot(offsetX, offsetY);
  if (distance < INNER_RADIUS || distance > OUTER_RADIUS) return null;
  const degrees = (Math.atan2(offsetY, offsetX) * 180) / Math.PI;
  // atan2 measures from the +x axis; shift so "up" starts at -135°.
  const shifted = (degrees + 135 + 360) % 360;
  return Math.floor(shifted / 90);
}

export function RadialMenu({
  point,
  items,
  label,
  onClose,
}: {
  point: ContextMenuPoint;
  items: readonly RadialMenuSlot[];
  label: string;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  /*
    The marking gesture only counts a right-button release that follows a
    right-button press seen while the ring is open. The press that opened the
    ring precedes the mount, so its trailing release (macOS fires
    `contextmenu` on press-down) never runs an action by itself.
  */
  const rightPressedRef = useRef(false);

  const firstEnabledIndex = items.findIndex((item) => !item.disabled);

  // The right-click interrupted whatever owned focus; closing puts it back so
  // the ring never strands focus on `<body>`.
  useEffect(() => {
    const interrupted =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      if (interrupted?.isConnected) interrupted.focus();
    };
  }, []);

  // Reveal on the frame after mount so the first paint is already placed; the
  // CSS transition then runs from a measured surface, never the origin.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const select = useCallback(
    (index: number | null) => {
      if (index === null) {
        onClose();
        return;
      }
      const item = items[index];
      if (!item || item.disabled) return;
      onClose();
      item.onSelect();
    },
    [items, onClose],
  );

  useEffect(() => {
    const root = rootRef.current;
    const onOutside = (event: Event) => {
      if (event.target instanceof Node && root?.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const resolveAtPoint = (event: PointerEvent): number | null => {
      const rect = root?.getBoundingClientRect();
      if (!rect) return null;
      return slotAt(
        event.clientX - rect.left - OUTER_RADIUS,
        event.clientY - rect.top - OUTER_RADIUS,
      );
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) rightPressedRef.current = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 2 || !rightPressedRef.current) return;
      rightPressedRef.current = false;
      // A release on a wedge runs it; a release in the hub or the margin
      // dismisses without running anything.
      select(resolveAtPoint(event));
    };
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("contextmenu", onOutside, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("contextmenu", onOutside, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose, select]);

  // Focus the first actionable item; when every slot is empty, focus the menu
  // itself so keyboard dismissal remains available.
  useEffect(() => {
    const firstEnabledItem = itemRefs.current[firstEnabledIndex];
    if (firstEnabledItem) {
      firstEnabledItem.focus({ preventScroll: true });
    } else {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, [firstEnabledIndex]);

  useEffect(() => {
    if (activeIndex === null) return;
    itemRefs.current[activeIndex]?.focus({ preventScroll: true });
  }, [activeIndex]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      onClose();
      return;
    }
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    if (!items.length) return;
    const focusedIndex = itemRefs.current.findIndex(
      (item) => item === document.activeElement,
    );
    setActiveIndex((current) => {
      const cursor = current ?? focusedIndex;
      const startIndex =
        cursor >= 0 ? cursor : step > 0 ? items.length - 1 : 0;
      for (let distance = 1; distance <= items.length; distance += 1) {
        const index =
          (startIndex + step * distance + items.length) % items.length;
        if (!items[index]?.disabled) return index;
      }
      return current;
    });
  };

  const width = OUTER_RADIUS * 2;
  const left = Math.round(
    Math.max(
      CONTEXT_MENU_MARGIN,
      Math.min(
        point.x - OUTER_RADIUS,
        window.innerWidth - width - CONTEXT_MENU_MARGIN,
      ),
    ),
  );
  const top = Math.round(
    Math.max(
      CONTEXT_MENU_MARGIN,
      Math.min(
        point.y - OUTER_RADIUS,
        window.innerHeight - width - CONTEXT_MENU_MARGIN,
      ),
    ),
  );

  return portalToBody(
    <div
      ref={rootRef}
      className={`radial-menu${open ? " is-open" : ""}`}
      style={{ top: `${top}px`, left: `${left}px`, width, height: width }}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setActiveIndex(
          slotAt(
            event.clientX - rect.left - OUTER_RADIUS,
            event.clientY - rect.top - OUTER_RADIUS,
          ),
        );
      }}
      onPointerLeave={() => setActiveIndex(null)}
      onClick={(event) => {
        // Resolve from the click, not from the last pointer move: a right-click
        // followed immediately by a left click never moved the pointer.
        const rect = event.currentTarget.getBoundingClientRect();
        select(
          slotAt(
            event.clientX - rect.left - OUTER_RADIUS,
            event.clientY - rect.top - OUTER_RADIUS,
          ),
        );
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <svg
        className="radial-menu-plate"
        viewBox={`0 0 ${width} ${width}`}
        aria-hidden="true"
      >
        {WEDGE_ANGLES.map(([start, end], index) => (
          <path
            key={start}
            className={`radial-menu-wedge${activeIndex === index ? " is-active" : ""}`}
            d={wedgePath(start, end)}
          />
        ))}
        <circle
          className="radial-menu-hub"
          cx={OUTER_RADIUS}
          cy={OUTER_RADIUS}
          r={INNER_RADIUS}
        />
        <circle
          className="radial-menu-dot"
          cx={OUTER_RADIUS}
          cy={OUTER_RADIUS}
          r={2.5}
        />
      </svg>
      {items.map((item, index) => {
        const angle = rad(ITEM_ANGLES[index] ?? -90);
        const x = OUTER_RADIUS + Math.cos(angle) * CONTENT_RADIUS;
        const y = OUTER_RADIUS + Math.sin(angle) * CONTENT_RADIUS;
        return (
          <button
            key={item.id}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            role="menuitem"
            aria-label={item.label}
            className="radial-menu-item"
            data-active={activeIndex === index ? "true" : undefined}
            disabled={item.disabled}
            style={{
              left: `${x}px`,
              top: `${y}px`,
              width: `${ITEM_WIDTH}px`,
              height: `${ITEM_HEIGHT}px`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              select(index);
            }}
            onFocus={() => setActiveIndex(index)}
            onPointerEnter={() => setActiveIndex(index)}
          >
            <span className="radial-menu-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="radial-menu-label">{item.label}</span>
          </button>
        );
      })}
    </div>,
  );
}
