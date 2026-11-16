import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SessionThinkingLevel } from "@pi-desktop/shared";

const SLIDER_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", "Enter",
]);

type Props = {
  levels: readonly SessionThinkingLevel[];
  level: string;
  label: string;
  commit: (level: SessionThinkingLevel) => Promise<boolean>;
};

/**
 * Segmented reasoning control. A native range overlays the segments and owns
 * keyboard, drag and accessibility; the raised pill (the thumb) and the labels
 * underneath it are decoration that share the range's column geometry.
 */
export function ThinkingLevelSlider({ levels, level, label, commit }: Props) {
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<{ id: number; x: number } | null>(null);
  const request = useRef(0);
  const confirmedIndex = Math.max(0, levels.findIndex((candidate) => candidate === level));
  const index = pendingIndex ?? confirmedIndex;

  useEffect(() => () => { request.current += 1; }, []);

  const select = (next: number) => {
    const target = levels[next];
    if (!target || next === index) return;
    setPendingIndex(next);
    const revision = ++request.current;
    // The controller owns error reporting and serial persistence. Only the
    // latest request may roll back this optimistic visual selection; older
    // completions must not snap a newer click back to a stale level.
    void commit(target).then(() => {
      if (request.current === revision) setPendingIndex(null);
    });
  };
  const finishPointer = () => {
    pointer.current = null;
    setDragging(false);
  };

  return <div
    className="composer-thinking-slider"
    data-dragging={dragging ? "true" : undefined}
    onPointerMove={(event) => {
      if (event.pointerType === "touch" || !rail.current) return;
      // The native range covers the labels; resolve the pointer against the
      // same equal-width columns the labels and the pill use.
      const bounds = rail.current.getBoundingClientRect();
      const next = Math.floor((event.clientX - bounds.left) / bounds.width * levels.length);
      setHoveredIndex(next >= 0 && next < levels.length ? next : null);
    }}
    onPointerLeave={() => setHoveredIndex(null)}
    onPointerCancel={() => setHoveredIndex(null)}
    style={{
      "--stop-count": levels.length,
      "--composer-thinking-progress": `${index / levels.length * 100}%`,
    } as CSSProperties}
  >
    <div className="composer-thinking-rail" ref={rail}>
      <span className="composer-thinking-thumb" aria-hidden="true" />
      <div className="composer-thinking-ticks" aria-hidden="true">
        {levels.map((candidate, stop) => <button key={candidate} type="button" tabIndex={-1}
          data-hovered={hoveredIndex === stop ? "true" : undefined}
          className={`composer-thinking-tick ${index === stop ? "active" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => select(stop)}>{candidate}</button>)}
      </div>
      <input
        type="range"
        className="composer-thinking-range"
        min={0} max={levels.length - 1} step={1} value={index}
        aria-label={label} aria-valuetext={levels[index] ?? level}
        onChange={(event) => select(Number(event.target.value))}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          pointer.current = { id: event.pointerId, x: event.clientX };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const origin = pointer.current;
          if (origin?.id === event.pointerId && Math.abs(event.clientX - origin.x) > 3) setDragging(true);
        }}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onLostPointerCapture={finishPointer}
        onKeyDown={(event) => {
          if (SLIDER_KEYS.has(event.key)) event.stopPropagation();
        }}
      />
    </div>
  </div>;
}
