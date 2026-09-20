import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { visibleNeighborMove, type ReorderPlacement } from "../lib/list-reorder";

type Row = { id: string; top: number; height: number; node: HTMLLIElement };
type Drag = {
  id: string;
  pointerId: number;
  index: number;
  armed: boolean;
  rows: Row[];
  cleanup: () => void;
};

/** React owns the list; this hook owns transient transforms until release/cancel. */
export function useCardReorder(
  items: readonly { id: string }[],
  busy: boolean,
  move: (id: string, target: string, placement: ReorderPlacement) => void,
) {
  const nodes = useRef(new Map<string, HTMLLIElement>());
  const drag = useRef<Drag | null>(null);
  const latest = useRef({ busy, move });
  latest.current = { busy, move };
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const disabled = busy || items.length < 2;

  const cancel = () => {
    drag.current?.cleanup();
    drag.current = null;
    setDraggingId(null);
  };
  useEffect(() => () => { drag.current?.cleanup(); }, []);
  useEffect(() => {
    const current = drag.current;
    if (current && (busy || current.rows.length !== items.length || current.rows.some((row, index) => row.id !== items[index]?.id))) cancel();
  }, [items, busy]);

  const rowEvents = (id: string): HTMLAttributes<HTMLLIElement> => ({
    tabIndex: disabled ? -1 : 0,
    "aria-disabled": disabled,
    onKeyDown(event) {
      if (event.target !== event.currentTarget || drag.current || disabled || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      event.stopPropagation();
      const neighbor = visibleNeighborMove(items, id, event.key === "ArrowDown" ? "down" : "up");
      if (neighbor) move(id, neighbor.targetId, neighbor.placement);
    },
    onDragStart(event) { event.preventDefault(); },
    onClickCapture(event) {
      if (suppressClick.current) {
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onPointerDown(event) {
      suppressClick.current = false;
      if (disabled || event.button !== 0 || drag.current) return;
      const target = event.target as Element;
      if (target.closest("button, input, select, textarea, a, [contenteditable=true]")) return;
      // Read layout once, before any transform or scroll write.
      const rows = items.flatMap((item) => {
        const node = nodes.current.get(item.id);
        if (!node) return [];
        const rect = node.getBoundingClientRect();
        return [{ id: item.id, top: rect.top, height: rect.height, node }];
      });
      const sourceIndex = rows.findIndex((row) => row.id === id);
      if (sourceIndex < 0) return;
      const source = rows[sourceIndex];
      const centers = rows.filter((row) => row.id !== id).map((row) => row.top + row.height / 2);
      const gap = rows.length > 1 ? rows[1].top - rows[0].top - rows[0].height : 0;
      const shift = source.height + gap;
      let scrollParent = event.currentTarget.parentElement;
      while (scrollParent && !/(auto|scroll)/.test(getComputedStyle(scrollParent).overflowY)) scrollParent = scrollParent.parentElement;
      const scrollBounds = scrollParent?.getBoundingClientRect();
      const initialScroll = scrollParent?.scrollTop ?? 0;
      const maxScroll = scrollParent ? Math.max(0, scrollParent.scrollHeight - scrollParent.clientHeight) : 0;
      const startX = event.clientX;
      const startY = event.clientY;
      let lastX = startX;
      let lastY = startY;
      let paintedX = 0;
      let paintedY = 0;
      let paintedIndex = sourceIndex;
      let frame = 0;
      const update = () => {
        const current = drag.current;
        if (!current?.armed) return;
        const dx = lastX - startX;
        const dy = lastY - startY + (scrollParent?.scrollTop ?? 0) - initialScroll;
        const center = source.top + source.height / 2 + dy;
        let low = 0;
        let high = centers.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (centers[middle] < center) low = middle + 1;
          else high = middle;
        }
        current.index = low;
        if (dx !== paintedX || dy !== paintedY) {
          source.node.style.transform = `translate(${dx}px, ${dy}px)`;
          paintedX = dx;
          paintedY = dy;
        }
        // Neighbours move only when the destination changes, not on every pointer event.
        if (paintedIndex !== current.index) {
          rows.forEach((row, index) => {
            if (index === sourceIndex) return;
            const offset = sourceIndex < index && index <= current.index ? -shift
              : current.index <= index && index < sourceIndex ? shift : 0;
            const transform = offset ? `translateY(${offset}px)` : "";
            if (row.node.style.transform !== transform) row.node.style.transform = transform;
          });
          paintedIndex = current.index;
        }
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
      const paint = () => {
        frame = 0;
        if (!drag.current?.armed) return;
        let scrolled = false;
        if (scrollParent && scrollBounds) {
          const edge = Math.min(40, scrollBounds.height / 4);
          const speed = lastY < scrollBounds.top + edge
            ? -Math.min(12, (scrollBounds.top + edge - lastY) / 3)
            : lastY > scrollBounds.bottom - edge ? Math.min(12, (lastY - scrollBounds.bottom + edge) / 3) : 0;
          const before = scrollParent.scrollTop;
          if (speed) scrollParent.scrollTop = Math.max(0, Math.min(maxScroll, before + speed));
          scrolled = scrollParent.scrollTop !== before;
        }
        update();
        // No permanent frame loop: stationary pointers and scroll limits become idle.
        if (scrolled) schedule();
      };
      const onMove = (next: PointerEvent) => {
        const current = drag.current;
        if (!current || next.pointerId !== current.pointerId) return;
        lastX = next.clientX;
        lastY = next.clientY;
        if (!current.armed && Math.hypot(lastX - startX, lastY - startY) < 6) return;
        if (!current.armed) {
          current.armed = true;
          source.node.style.zIndex = "2";
          source.node.style.willChange = "transform";
          setDraggingId(id);
        }
        suppressClick.current = true;
        next.preventDefault();
        schedule();
      };
      const finish = (next: PointerEvent) => {
        const current = drag.current;
        if (!current || next.pointerId !== current.pointerId) return;
        // A release can arrive before the scheduled frame; consume its latest move.
        update();
        const destination = current.rows[current.index];
        const shouldMove = current.armed && current.index !== sourceIndex;
        cancel();
        if (shouldMove && !latest.current.busy) {
          latest.current.move(id, destination.id, current.index > sourceIndex ? "after" : "before");
        }
      };
      const onCancel = (next: PointerEvent) => { if (next.pointerId === drag.current?.pointerId) cancel(); };
      const onKey = (next: KeyboardEvent) => {
        if (next.key === "Escape") { next.preventDefault(); cancel(); }
      };
      const onBlur = () => cancel();
      const onScroll = (next: Event) => {
        if (!drag.current?.armed) return;
        if (next.target === scrollParent) schedule();
        else if (next.target === document || (next.target instanceof Element && next.target.contains(source.node))) {
          const expectedTop = source.top - ((scrollParent?.scrollTop ?? 0) - initialScroll) + paintedY;
          if (Math.abs(source.node.getBoundingClientRect().top - expectedTop) > 1) cancel();
        }
      };
      const cleanup = () => {
        cancelAnimationFrame(frame);
        rows.forEach(({ node }) => { node.style.removeProperty("transform"); });
        source.node.style.removeProperty("z-index");
        source.node.style.removeProperty("will-change");
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("resize", onBlur);
        window.removeEventListener("scroll", onScroll, true);
      };
      drag.current = { id, pointerId: event.pointerId, index: sourceIndex, armed: false, rows, cleanup };
      window.addEventListener("pointermove", onMove, { capture: true, passive: false });
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onBlur);
      window.addEventListener("resize", onBlur);
      window.addEventListener("scroll", onScroll, true);
    },
  });

  return {
    draggingId,
    rowEvents,
    rowRef: (id: string) => (node: HTMLLIElement | null) => {
      if (node) nodes.current.set(id, node);
      else nodes.current.delete(id);
    },
  };
}
