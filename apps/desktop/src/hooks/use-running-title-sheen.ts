import { useLayoutEffect, useRef, type RefObject } from "react";

/** A row's title span, which is a flex item and therefore has a box to watch. */
const TITLE_SELECTOR = ".thread-item.running .thread-item-title";

/** Band thickness in pixels. Also written to `--sheen-band` for the gradient. */
const BAND = 64;
/** How fast the band crosses the glyphs, in pixels per second. */
const SPEED = 80;
/** Rest between passes, in seconds. */
const PAUSE = 0.33;

type Sheen = { animation: Animation; cycleMs: number };

/**
 * Draws the running sweep on every running row's title.
 *
 * A sweep is a physical light passing over glyphs, so its thickness and its
 * speed are both lengths, never a share of the row. Sized as percentages they
 * become two different effects in one list: the same stop is a fat, slow bar
 * on a three-word session and a thin, fast one on a thirty-word session.
 *
 * Neither the width nor the pacing can be left to the stylesheet. The band has
 * to travel `width + band` pixels to cross a row and clear both edges, which
 * ties the duration to the title — but `animation-duration` is resolved before
 * layout, and `calc()` cannot read the element's own size. The pause is worse:
 * a fixed keyframe percentage can only hold the band for a fixed *share* of
 * the cycle, so a short row would rest for a fraction of a second while a long
 * one rested for seconds. And the pause boundary itself cannot be a CSS
 * variable at all, because `var()` is not a valid keyframe selector — a
 * stylesheet that tries it silently loses that keyframe.
 *
 * So the geometry is measured here and the animation is built here. The
 * stylesheet keeps the gradient and the clipping, which are the part that is
 * genuinely declarative; everything that has to know a pixel count is this
 * hook's job.
 *
 * The keyframe offsets are computed rather than fixed, so the rest is the same
 * second on every row regardless of how long the title is. One observer covers
 * the whole list rather than one per row: measuring a handful of elements
 * costs far less than the per-frame paint the animation already does, and it
 * keeps the work out of the row components.
 */
export function useRunningTitleSheen(
  container: RefObject<HTMLElement | null>,
  runningIds: readonly string[],
) {
  // Rows mount, unmount and swap in and out of the running set without the
  // observer hearing about it — a class change is not a resize. Key the
  // effect on which rows are running so the observed set is rebuilt then.
  const signature = runningIds.join(" ");
  const latest = useRef(signature);
  latest.current = signature;

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sheens = new Map<HTMLElement, Sheen>();

    const paint = (title: HTMLElement) => {
      const width = title.getBoundingClientRect().width;
      if (width <= 0) return;

      // The stylesheet's band and the hook's must not drift apart, so the
      // number the geometry is computed from is the one written for the
      // gradient to use.
      title.style.setProperty("--sheen-band", `${BAND}px`);
      title.style.setProperty("--sheen-width", `${width}px`);

      // Reduced motion still gets the resting appearance: the stylesheet
      // parks the band off-screen without this, so the title reads at its own
      // colour and simply never moves.
      if (reduceMotion.matches) {
        sheens.get(title)?.animation.cancel();
        sheens.delete(title);
        return;
      }

      const travel = width + BAND;
      const passMs = (travel / SPEED) * 1000;
      const cycleMs = passMs + PAUSE * 1000;
      const previous = sheens.get(title);
      const animation = title.animate(
        [
          { backgroundPosition: `${-travel}px 0px`, offset: 0 },
          { backgroundPosition: "0px 0px", offset: passMs / cycleMs },
          { backgroundPosition: "0px 0px", offset: 1 },
        ],
        { duration: cycleMs, iterations: Infinity, easing: "linear" },
      );

      // Carry the pass over instead of restarting it. A title changing while
      // its session runs is ordinary, and snapping the band back to the left
      // edge reads as that row's animation stalling.
      if (previous) {
        // `currentTime` is typed as a CSSNumberish because it can be a
        // registered custom property; this one is always a millisecond count.
        const elapsed = Number(previous.animation.currentTime ?? 0);
        animation.currentTime = (elapsed / previous.cycleMs) * cycleMs;
      }

      previous?.animation.cancel();
      sheens.set(title, { animation, cycleMs });
    };

    // The container is watched alongside the rows: the sidebar is
    // drag-resizable and no row re-renders when the rail changes width.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === root) {
          for (const title of root.querySelectorAll<HTMLElement>(TITLE_SELECTOR)) {
            paint(title);
          }
        } else {
          paint(entry.target as HTMLElement);
        }
      }
    });

    const collect = () => {
      observer.disconnect();
      observer.observe(root);
      for (const title of root.querySelectorAll<HTMLElement>(TITLE_SELECTOR)) {
        observer.observe(title);
        paint(title);
      }
    };

    const onMotionChange = () => {
      for (const title of sheens.keys()) paint(title);
    };
    reduceMotion.addEventListener("change", onMotionChange);

    // Painted before paint, so no row is ever shown on a placeholder width.
    collect();

    return () => {
      reduceMotion.removeEventListener("change", onMotionChange);
      observer.disconnect();
      for (const [title, sheen] of sheens) {
        sheen.animation.cancel();
        // Leave no stale geometry behind for a row that starts running again
        // before the next measurement.
        title.style.removeProperty("--sheen-width");
        title.style.removeProperty("--sheen-band");
      }
      sheens.clear();
    };
  }, [container, signature]);
}
