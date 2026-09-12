/**
 * Placement for the composer's context-usage popover (D357).
 *
 * The popover is portaled to `document.body`, positioned in viewport
 * coordinates, and floats above pane stacking (`z-command-palette`). None of
 * that protects it from the work panel: the panel's embedded browser and plugin
 * views are native `WebContentsView`s that composite above every renderer
 * layer, so whatever part of the popover crosses the pane's right edge is
 * covered no matter which `z-index` the popover carries.
 *
 * The clamp therefore uses the conversation pane — which ends exactly where the
 * panel begins — instead of the viewport, and reports the widest box the pane
 * can still afford so a narrow pane cannot push the popover under the panel
 * either.
 */

export const CONTEXT_INSPECTOR_MARGIN = 16;
export const CONTEXT_INSPECTOR_GAP = 8;

/** The trigger's viewport rect; only the edges placement reads are required. */
export type ContextInspectorTrigger = {
  left: number;
  top: number;
  bottom: number;
};

/** Horizontal extent of the box the popover has to stay inside. */
export type ContextInspectorBox = {
  left: number;
  right: number;
};

export type ContextInspectorPlacement = {
  top: number;
  left: number;
  /** Caps the popover's own `width` so a narrow pane cannot overflow. */
  maxWidth: number;
};

/**
 * Place the popover above the trigger when it fits, below it otherwise, and
 * inside `pane` on the horizontal axis. Returns `null` when the box has no
 * usable width, which the caller treats as "leave the popover closed".
 */
export function placeContextInspector({
  trigger,
  popover,
  pane,
  viewport,
  margin = CONTEXT_INSPECTOR_MARGIN,
  gap = CONTEXT_INSPECTOR_GAP,
}: {
  trigger: ContextInspectorTrigger;
  popover: { width: number; height: number };
  /** The conversation pane; `null` falls back to the viewport. */
  pane: ContextInspectorBox | null;
  viewport: { width: number; height: number };
  margin?: number;
  gap?: number;
}): ContextInspectorPlacement | null {
  const left = (pane ? pane.left : 0) + margin;
  const right = (pane ? pane.right : viewport.width) - margin;
  const maxWidth = Math.floor(right - left);
  if (maxWidth <= 0) return null;

  // A pane narrower than the popover caps the popover rather than letting it
  // run under the panel; the widest placement still ends at the pane's edge.
  const width = Math.min(popover.width, maxWidth);
  const maximumLeft = Math.max(left, right - width);
  const clampedLeft = Math.min(Math.max(left, trigger.left), maximumLeft);

  const above = trigger.top - popover.height - gap;
  const below = trigger.bottom + gap;
  const maximumTop = Math.max(
    margin,
    viewport.height - popover.height - margin,
  );
  const top =
    above >= margin && above <= maximumTop
      ? above
      : below >= margin && below <= maximumTop
        ? below
        : Math.min(Math.max(margin, below), maximumTop);

  return { top, left: clampedLeft, maxWidth };
}
