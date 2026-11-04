import { useEffect, useRef, useState } from "react";
import type { ComputerCursorEvent, ComputerRect } from "@pi-desktop/shared";
import { computerUseApi } from "./computer-use-api";
import "../../styles/computer-cursor.css";

/**
 * The agent's drawn cursor (ADR 0342 §10).
 *
 * This surface renders in its own click-through window, so it can never take a
 * press away from the user. It owns no part of any action: it is told where an
 * action is about to land and shows it, which is the only way an accessibility
 * press — which moves no real pointer — becomes visible at all.
 *
 * Coordinates arrive in screen space; the window is positioned around the
 * target, so they are converted with the window's own screen origin.
 */

type Trail = { id: number; x: number; y: number; kind: "press" | "type" };

export function ComputerCursor() {
  const [origin, setOrigin] = useState<ComputerRect | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [trail, setTrail] = useState<Trail[]>([]);
  const nextId = useRef(1);

  useEffect(
    () =>
      computerUseApi.onCursor((event: ComputerCursorEvent) => {
        if (event.kind === "show") {
          setOrigin(event.bounds);
          setPoint(null);
          setLabel(null);
          setTrail([]);
          return;
        }
        if (event.kind === "hide") {
          setPoint(null);
          setLabel(null);
          setTrail([]);
          return;
        }
        setPoint({ x: event.x, y: event.y });
        if (event.kind === "move") {
          setLabel(event.label ?? null);
          return;
        }
        const id = nextId.current++;
        setTrail((current) => [
          ...current.slice(-3),
          { id, x: event.x, y: event.y, kind: event.kind === "type" ? "type" : "press" },
        ]);
        // The ripple is a hint that something happened, not state to keep.
        window.setTimeout(() => {
          setTrail((current) => current.filter((item) => item.id !== id));
        }, 600);
      }),
    [],
  );

  if (!point) return null;
  // `window.screenX/Y` is the overlay window's own origin, which is how a
  // screen coordinate becomes a position inside this surface.
  const left = point.x - window.screenX;
  const top = point.y - window.screenY;
  const inside =
    left >= 0 && top >= 0 && left <= window.innerWidth && top <= window.innerHeight;
  if (!inside) return null;

  return (
    <div className="computer-cursor-surface" aria-hidden="true" data-grant={origin ? "active" : "idle"}>
      {trail.map((item) => (
        <span
          key={item.id}
          className={`computer-cursor-ripple computer-cursor-ripple-${item.kind}`}
          style={{ left: item.x - window.screenX, top: item.y - window.screenY }}
        />
      ))}
      <span className="computer-cursor-pointer" style={{ left, top }}>
        <svg viewBox="0 0 24 24" width="22" height="22" role="presentation">
          <path
            d="M5 2.5 19 12l-6.2 1.2L16 21l-2.6 1-3.2-7.6L5 18.6Z"
            fill="currentColor"
            stroke="rgba(0,0,0,0.55)"
            strokeWidth="1.2"
          />
        </svg>
      </span>
      {label && (
        <span className="computer-cursor-label" style={{ left, top }}>
          {label}
        </span>
      )}
    </div>
  );
}
