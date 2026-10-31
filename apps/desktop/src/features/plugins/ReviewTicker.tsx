import { useEffect, useState } from "react";
import type { PluginReviewTicker } from "@pi-desktop/shared";

/** How long one review line stays on screen before the next one fades in. */
const ADVANCE_MS = 6000;

/**
 * The one-line review a marketplace card carries.
 *
 * The center selects and orders the rows; this only plays them. The line is
 * supplementary — the description is what the card is for — so it is one
 * clamped line, it pauses while the pointer or focus is on it, and a reader who
 * asked for reduced motion sees the first row only.
 */
export function ReviewTicker({ ticker }: { ticker?: PluginReviewTicker }) {
  const rows = ticker?.rows ?? [];
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    setIndex(0);
  }, [ticker?.pluginId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (paused || reducedMotion || rows.length <= 1) return;
    const handle = window.setInterval(() => {
      setIndex((current) => (current + 1) % rows.length);
    }, ADVANCE_MS);
    return () => window.clearInterval(handle);
  }, [paused, reducedMotion, rows.length]);

  if (rows.length === 0) return null;
  const row = rows[index] ?? rows[0];

  return (
    <span
      className="plugins-card-review"
      title={row.body}
      aria-live="off"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span key={row.id} className="plugins-card-review-text">
        {row.body}
      </span>
    </span>
  );
}
