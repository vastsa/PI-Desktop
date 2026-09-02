export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function windowBoundsEqual(a: WindowBounds, b: WindowBounds): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

export type WorkPanelReservationState = {
  width: number;
  xOffset: number;
};

export const WORK_PANEL_MIN_WIDTH = 244;
export const WORK_PANEL_MAX_WIDTH = 720;
export const WORK_PANEL_CHAT_MIN_WIDTH = 1040;
export const WORK_PANEL_CHAT_MAX_WIDTH = 10000;

export const emptyWorkPanelReservationState = (): WorkPanelReservationState => ({
  width: 0,
  xOffset: 0,
});

export function displayWorkAreaKey(
  displayId: string | number,
  workArea: WindowBounds,
): string {
  return [
    displayId,
    workArea.x,
    workArea.y,
    workArea.width,
    workArea.height,
  ].join(":");
}

export function baseWindowBounds(
  bounds: WindowBounds,
  reservation: WorkPanelReservationState,
): WindowBounds {
  return {
    ...bounds,
    x: bounds.x - reservation.xOffset,
    width: bounds.width - reservation.width,
  };
}

/**
 * Why the window sits on a display other than the one whose work area
 * produced the last applied bounds.
 *
 * - `none`: same display. Native deltas are the user's own move or resize.
 * - `os-adjusted`: the OS re-fitted bounds we asked for, or the display
 *   topology changed under us. The base bounds we planned from are still the
 *   user's intent and must survive so returning to a roomy display can
 *   restore the full reservation.
 * - `user-moved`: the user dragged the window across a display boundary. The
 *   current position is the new intent; reusing the previous base bounds would
 *   teleport the window back to the old display's coordinates.
 */
export type DisplayTransition = "none" | "os-adjusted" | "user-moved";

export function reconcileBaseWindowBounds({
  baseBounds,
  lastAppliedBounds,
  currentBounds,
  displayTransition,
  reservation,
}: {
  baseBounds: WindowBounds;
  lastAppliedBounds: WindowBounds;
  currentBounds: WindowBounds;
  displayTransition: DisplayTransition;
  reservation: WorkPanelReservationState;
}): WindowBounds {
  if (displayTransition === "os-adjusted") return { ...baseBounds };
  if (displayTransition === "user-moved") {
    return baseWindowBounds(currentBounds, reservation);
  }

  return {
    x: baseBounds.x + currentBounds.x - lastAppliedBounds.x,
    y: baseBounds.y + currentBounds.y - lastAppliedBounds.y,
    width: Math.max(
      0,
      baseBounds.width + currentBounds.width - lastAppliedBounds.width,
    ),
    height: Math.max(
      0,
      baseBounds.height + currentBounds.height - lastAppliedBounds.height,
    ),
  };
}

/**
 * Moves a rect so its origin lies inside a work area, never changing its size.
 * Used to normalize base bounds after the user drags the window to another
 * display, so the reservation is planned from a position that exists on the
 * target display.
 *
 * Size is deliberately preserved even when the rect is larger than the work
 * area: base bounds are the user's intent under ADR 0122 and must stay
 * restorable when the window returns to a roomier display. Shrinking here would
 * be persisted and could never be undone. An oversized rect is pinned to the
 * work area's top-left instead, and `planWorkPanelReservation` still caps the
 * width it adds on top.
 */
export function clampBoundsOriginToWorkArea(
  bounds: WindowBounds,
  workArea: WindowBounds,
): WindowBounds {
  const maximumX = workArea.x + workArea.width - bounds.width;
  const maximumY = workArea.y + workArea.height - bounds.height;
  return {
    ...bounds,
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, maximumX))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, maximumY))),
  };
}

export function planWorkPanelReservation({
  baseBounds,
  workArea,
  requestedWidth,
}: {
  baseBounds: WindowBounds;
  workArea: WindowBounds;
  requestedWidth: number;
}): { bounds: WindowBounds; reservation: WorkPanelReservationState } {
  const base = { ...baseBounds };
  const availableWidth = Math.max(0, workArea.width - base.width);
  const reservedWidth = Math.min(requestedWidth, availableWidth);
  const width = base.width + reservedWidth;
  const workAreaRight = workArea.x + workArea.width;
  const maximumX = workAreaRight - width;
  const x =
    width <= workArea.width
      ? Math.max(workArea.x, Math.min(base.x, maximumX))
      : base.x;

  return {
    bounds: { ...base, x, width },
    reservation: {
      width: reservedWidth,
      xOffset: x - base.x,
    },
  };
}

export function parseWorkPanelReservationWidth(input: unknown): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const width = (input as { width?: unknown }).width;
  if (
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    (width !== 0 &&
      (width < WORK_PANEL_MIN_WIDTH || width > WORK_PANEL_MAX_WIDTH))
  ) {
    return null;
  }
  return width;
}

export function parseWorkPanelChatWidth(input: unknown): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const width = (input as { width?: unknown }).width;
  if (
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < WORK_PANEL_CHAT_MIN_WIDTH ||
    width > WORK_PANEL_CHAT_MAX_WIDTH
  ) {
    return null;
  }
  return width;
}

export function isWorkPanelOuterResizeEdge(edge: unknown): boolean {
  return edge === "right" || edge === "top-right" || edge === "bottom-right";
}
