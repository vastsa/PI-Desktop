import { useEffect, useRef, useState, type PointerEvent } from "react";

type Selection = { hunk: number; anchor: number; end: number };
type Drag = {
  pointerId: number;
  target: HTMLButtonElement;
  y: number;
  startY: number;
  moved: boolean;
  previous: Selection | null;
};

/** Own pointer capture and scrolling for one historical diff editor. */
export function useReviewLineSelection() {
  const rootRef = useRef<HTMLDivElement>(null);
  const current = useRef<Selection | null>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState(false);
  const update = (next: Selection | null) => {
    current.current = next;
    setSelection(next);
  };
  const stopCapture = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const active = drag.current;
    drag.current = null;
    if (active?.target.hasPointerCapture(active.pointerId))
      active.target.releasePointerCapture(active.pointerId);
  };
  const updateEnd = (y: number) => {
    const value = current.current;
    if (!value) return;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>(
      `[data-review-hunk="${value.hunk}"][data-review-line]`,
    );
    if (!rows?.length) return;
    let end = value.end;
    for (const row of rows) {
      end = Number(row.dataset.reviewLine);
      if (y <= row.getBoundingClientRect().bottom) break;
    }
    if (end !== value.end) update({ ...value, end });
  };
  const scroll = () => {
    const active = drag.current;
    if (!active) return;
    const container = rootRef.current?.closest<HTMLElement>(
      ".review-change-card-body",
    );
    if (container && active.moved) {
      const rect = container.getBoundingClientRect();
      const delta =
        active.y < rect.top + 24 ? -10 : active.y > rect.bottom - 24 ? 10 : 0;
      if (delta) {
        container.scrollTop += delta;
        updateEnd(active.y);
      }
    }
    frame.current = requestAnimationFrame(scroll);
  };
  const start = (
    event: PointerEvent<HTMLButtonElement>,
    hunk: number,
    line: number,
  ) => {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault();
    const previous = current.current;
    drag.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      y: event.clientY,
      startY: event.clientY,
      moved: false,
      previous,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    update(
      event.shiftKey && previous?.hunk === hunk
        ? { ...previous, end: line }
        : { hunk, anchor: line, end: line },
    );
    setDragging(true);
    frame.current = requestAnimationFrame(scroll);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (!drag.current.moved && Math.abs(event.clientY - drag.current.startY) < 3) return;
    drag.current.moved = true;
    drag.current.y = event.clientY;
    updateEnd(event.clientY);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    move(event);
    stopCapture();
    setDragging(false);
  };
  const cancel = () => {
    if (!drag.current) return;
    const previous = drag.current.previous;
    stopCapture();
    update(previous);
    setDragging(false);
  };
  useEffect(() => {
    const onBlur = () => cancel();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      stopCapture();
    };
  }, []);
  return {
    rootRef,
    selection,
    dragging,
    start,
    move,
    finish,
    cancel,
    clear: () => {
      stopCapture();
      update(null);
      setDragging(false);
    },
    keyboardSelect: (hunk: number, line: number, extend: boolean) => {
      const value = current.current;
      update(
        extend && value?.hunk === hunk
          ? { ...value, end: line }
          : { hunk, anchor: line, end: line },
      );
    },
  };
}
