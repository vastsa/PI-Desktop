import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type MouseEvent } from "react";

type Point = { x: number; y: number };
type Drag = { pointerId: number; element: HTMLImageElement; start: Point; origin: Point; moved: boolean };

/** Own pointer capture and keep a recoverable part of the image in view. */
export function useImagePreviewPan(id: string, src: string | undefined, bounds: Point) {
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const clamp = (point: Point): Point => ({
    x: Math.max(-bounds.x, Math.min(bounds.x, point.x)),
    y: Math.max(-bounds.y, Math.min(bounds.y, point.y)),
  });
  const offset = clamp(position);
  const release = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId);
    }
  }, []);
  const reset = useCallback(() => {
    release();
    suppressClick.current = false;
    setDragging(false);
    setPosition({ x: 0, y: 0 });
  }, [release]);
  useLayoutEffect(() => {
    reset();
    return release;
  }, [id, src, reset, release]);

  const end = (event: PointerEvent<HTMLImageElement>, cancelled = false) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    suppressClick.current = !cancelled && drag.current.moved;
    release();
    setDragging(false);
  };
  return {
    offset,
    reset,
    dragging,
    moveBy: (x: number, y: number) => setPosition(clamp({ x: offset.x + x, y: offset.y + y })),
    onPointerDownCapture: () => { suppressClick.current = false; },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    imageHandlers: {
      onPointerDown: (event: PointerEvent<HTMLImageElement>) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId, element: event.currentTarget,
          start: { x: event.clientX, y: event.clientY }, origin: offset, moved: false,
        };
        setDragging(true);
      },
      onPointerMove: (event: PointerEvent<HTMLImageElement>) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const x = event.clientX - current.start.x;
        const y = event.clientY - current.start.y;
        current.moved ||= Math.hypot(x, y) > 3;
        if (current.moved) setPosition(clamp({ x: current.origin.x + x, y: current.origin.y + y }));
      },
      onPointerUp: (event: PointerEvent<HTMLImageElement>) => end(event),
      onPointerCancel: (event: PointerEvent<HTMLImageElement>) => end(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLImageElement>) => end(event, true),
    },
  };
}
