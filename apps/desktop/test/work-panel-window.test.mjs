import assert from "node:assert/strict";
import test from "node:test";
import {
  baseWindowBounds,
  clampBoundsOriginToWorkArea,
  displayWorkAreaKey,
  emptyWorkPanelReservationState,
  isWorkPanelOuterResizeEdge,
  parseWorkPanelChatWidth,
  parseWorkPanelReservationWidth,
  planWorkPanelChatResize,
  planWorkPanelReservation,
  reconcileBaseWindowBounds,
} from "../electron/main/work-panel-window.ts";

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

test("right-side native edges own panel width while other edges remain chat-owned", () => {
  assert.equal(isWorkPanelOuterResizeEdge("right"), true);
  assert.equal(isWorkPanelOuterResizeEdge("top-right"), true);
  assert.equal(isWorkPanelOuterResizeEdge("bottom-right"), true);
  assert.equal(isWorkPanelOuterResizeEdge("left"), false);
  assert.equal(isWorkPanelOuterResizeEdge("bottom"), false);
});

test("chat resize IPC accepts only bounded integer widths", () => {
  assert.equal(parseWorkPanelChatWidth({ width: 1040 }), 1040);
  assert.equal(parseWorkPanelChatWidth({ width: 10000 }), 10000);
  assert.equal(parseWorkPanelChatWidth({ width: 1039 }), null);
  assert.equal(parseWorkPanelChatWidth({ width: 10000.5 }), null);
});

test("display work-area keys change with display geometry", () => {
  assert.equal(displayWorkAreaKey(1, workArea), "1:0:0:1920:1080");
  assert.notEqual(
    displayWorkAreaKey(1, workArea),
    displayWorkAreaKey(1, { ...workArea, width: 1720 }),
  );
  assert.notEqual(displayWorkAreaKey(1, workArea), displayWorkAreaKey(2, workArea));
});

test("reserves the full panel width when the work area has room", () => {
  const base = { x: 100, y: 80, width: 1000, height: 800 };
  const plan = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });

  assert.deepEqual(plan, {
    bounds: { x: 100, y: 80, width: 1420, height: 800 },
    reservation: { width: 420, xOffset: 0 },
  });
  assert.deepEqual(baseWindowBounds(plan.bounds, plan.reservation), base);
});

test("moves the window left when the right edge lacks room", () => {
  const base = { x: 700, y: 80, width: 1000, height: 800 };
  const plan = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });

  assert.deepEqual(plan, {
    bounds: { x: 500, y: 80, width: 1420, height: 800 },
    reservation: { width: 420, xOffset: -200 },
  });
  assert.deepEqual(baseWindowBounds(plan.bounds, plan.reservation), base);
});

test("releasing a reservation restores the exact base bounds", () => {
  const base = { x: 700, y: 80, width: 1000, height: 800 };
  const closed = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 0,
  });

  assert.deepEqual(closed, {
    bounds: base,
    reservation: emptyWorkPanelReservationState(),
  });
});

test("native resizing changes the base chat width without changing the panel reservation", () => {
  const base = { x: 700, y: 80, width: 1000, height: 800 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });
  const nativelyResizedBounds = {
    ...opened.bounds,
    width: opened.bounds.width + 150,
  };

  const resizedBase = reconcileBaseWindowBounds({
    baseBounds: base,
    lastAppliedBounds: opened.bounds,
    currentBounds: nativelyResizedBounds,
    displayTransition: "none",
    reservation: opened.reservation,
  });
  assert.deepEqual(resizedBase, { x: 700, y: 80, width: 1150, height: 800 });

  const replanned = planWorkPanelReservation({
    baseBounds: resizedBase,
    workArea,
    requestedWidth: 420,
  });

  assert.equal(replanned.reservation.width, 420);
  assert.deepEqual(baseWindowBounds(replanned.bounds, replanned.reservation), {
    x: 700,
    y: 80,
    width: 1150,
    height: 800,
  });
});

test("reserves only the available width when the work area is constrained", () => {
  const constrainedWorkArea = { x: 0, y: 0, width: 1100, height: 900 };
  const base = { x: 0, y: 40, width: 900, height: 800 };
  const plan = planWorkPanelReservation({
    baseBounds: base,
    workArea: constrainedWorkArea,
    requestedWidth: 420,
  });

  assert.deepEqual(plan, {
    bounds: { x: 0, y: 40, width: 1100, height: 800 },
    reservation: { width: 200, xOffset: 0 },
  });
  assert.deepEqual(baseWindowBounds(plan.bounds, plan.reservation), base);
});

test("chat resize keeps the active panel reservation when the work area is tight", () => {
  const constrainedWorkArea = { x: 0, y: 0, width: 1100, height: 900 };
  const base = { x: 0, y: 40, width: 900, height: 800 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea: constrainedWorkArea,
    requestedWidth: 420,
  });
  const resized = planWorkPanelChatResize({
    baseBounds: base,
    workArea: constrainedWorkArea,
    reservationWidth: opened.reservation.width,
    requestedWidth: 1000,
  });

  assert.equal(opened.reservation.width, 200);
  assert.deepEqual(resized, {
    bounds: { x: 0, y: 40, width: 1100, height: 800 },
    reservation: { width: 200, xOffset: 0 },
  });
});

test("chat resize keeps the current panel width while shrinking the base", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const base = { x: 100, y: 80, width: 1000, height: 800 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });
  const resized = planWorkPanelChatResize({
    baseBounds: base,
    workArea,
    reservationWidth: opened.reservation.width,
    requestedWidth: 800,
  });

  assert.equal(resized.reservation.width, opened.reservation.width);
  assert.deepEqual(baseWindowBounds(resized.bounds, resized.reservation), {
    x: 100,
    y: 80,
    width: 800,
    height: 800,
  });
});

test("planning the current reservation is idempotent", () => {
  const opened = planWorkPanelReservation({
    baseBounds: { x: 700, y: 80, width: 1000, height: 800 },
    workArea,
    requestedWidth: 420,
  });
  const repeated = planWorkPanelReservation({
    baseBounds: baseWindowBounds(opened.bounds, opened.reservation),
    workArea,
    requestedWidth: 420,
  });

  assert.deepEqual(repeated, opened);
});

test("display reconciliation preserves base bounds after the OS adjusts outer bounds", () => {
  const base = { x: 100, y: 80, width: 1200, height: 800 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });
  const osAdjustedBounds = { x: 0, y: 40, width: 1440, height: 760 };
  const preservedBase = reconcileBaseWindowBounds({
    baseBounds: base,
    lastAppliedBounds: opened.bounds,
    currentBounds: osAdjustedBounds,
    displayTransition: "os-adjusted",
    reservation: opened.reservation,
  });
  const constrained = planWorkPanelReservation({
    baseBounds: preservedBase,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    requestedWidth: 420,
  });
  const restored = planWorkPanelReservation({
    baseBounds: preservedBase,
    workArea,
    requestedWidth: 420,
  });

  assert.deepEqual(preservedBase, base);
  assert.equal(constrained.reservation.width, 240);
  assert.equal(restored.reservation.width, 420);
  assert.deepEqual(baseWindowBounds(constrained.bounds, constrained.reservation), base);
  assert.deepEqual(baseWindowBounds(restored.bounds, restored.reservation), base);
});

test("same-display native move and left-edge resize update persistent base bounds", () => {
  const base = { x: 100, y: 80, width: 1000, height: 800 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });
  const movedAndResized = {
    x: opened.bounds.x + 50,
    y: opened.bounds.y + 20,
    width: opened.bounds.width - 50,
    height: opened.bounds.height + 40,
  };

  assert.deepEqual(
    reconcileBaseWindowBounds({
      baseBounds: base,
      lastAppliedBounds: opened.bounds,
      currentBounds: movedAndResized,
      displayTransition: "none",
      reservation: opened.reservation,
    }),
    { x: 150, y: 100, width: 950, height: 840 },
  );
});

test("same-display observation uses the last actual outer bounds as its baseline", () => {
  const base = { x: 100, y: 80, width: 1200, height: 800 };
  const constrainedActual = { x: 0, y: 40, width: 1440, height: 760 };
  const userResized = { ...constrainedActual, width: 1490 };

  assert.deepEqual(
    reconcileBaseWindowBounds({
      baseBounds: base,
      lastAppliedBounds: constrainedActual,
      currentBounds: userResized,
      displayTransition: "none",
      reservation: emptyWorkPanelReservationState(),
    }),
    { x: 100, y: 80, width: 1250, height: 800 },
  );
});

// Second display to the right of `workArea`, as in the issue-18 report.
const rightWorkArea = { x: 1920, y: 0, width: 1920, height: 1080 };

test("dragging the window to another display adopts the dropped position", () => {
  const base = { x: 700, y: 80, width: 1000, height: 800 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });
  // The user dragged the whole window onto the right-hand display.
  const droppedBounds = {
    ...opened.bounds,
    x: 2400,
    y: 300,
  };

  const adopted = reconcileBaseWindowBounds({
    baseBounds: base,
    lastAppliedBounds: opened.bounds,
    currentBounds: droppedBounds,
    displayTransition: "user-moved",
    reservation: opened.reservation,
  });

  // Base bounds follow the drop, minus the reservation that is still applied.
  assert.deepEqual(adopted, { x: 2600, y: 300, width: 1000, height: 800 });

  const replanned = planWorkPanelReservation({
    baseBounds: adopted,
    workArea: rightWorkArea,
    requestedWidth: 420,
  });

  // The window keeps the position the user chose; only the reservation-induced
  // shift moves it, and it stays on the display it was dropped on.
  assert.deepEqual(replanned.bounds, {
    x: 2420,
    y: 300,
    width: 1420,
    height: 800,
  });
  assert.ok(replanned.bounds.x >= rightWorkArea.x);
  assert.ok(
    replanned.bounds.x + replanned.bounds.width <=
      rightWorkArea.x + rightWorkArea.width,
  );
  assert.deepEqual(baseWindowBounds(replanned.bounds, replanned.reservation), adopted);
});

test("a cross-display drag never replans from the previous display's origin", () => {
  const base = { x: 700, y: 80, width: 1200, height: 800 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });
  const droppedBounds = { ...opened.bounds, x: 2100, y: 250 };

  const userMoved = planWorkPanelReservation({
    baseBounds: reconcileBaseWindowBounds({
      baseBounds: base,
      lastAppliedBounds: opened.bounds,
      currentBounds: droppedBounds,
      displayTransition: "user-moved",
      reservation: opened.reservation,
    }),
    workArea: rightWorkArea,
    requestedWidth: 420,
  });
  const osAdjusted = planWorkPanelReservation({
    baseBounds: reconcileBaseWindowBounds({
      baseBounds: base,
      lastAppliedBounds: opened.bounds,
      currentBounds: droppedBounds,
      displayTransition: "os-adjusted",
      reservation: opened.reservation,
    }),
    workArea: rightWorkArea,
    requestedWidth: 420,
  });

  // The regression: treating the drag as an OS adjustment replans from the left
  // display's x, which the target work area then clamps to its left edge. That
  // is the jump users saw on pointer release (issue #18).
  assert.equal(osAdjusted.bounds.x, rightWorkArea.x);
  // Attributed to the user, the window stays where it was dropped, shifted only
  // by the reservation needed to fit the target work area.
  assert.equal(userMoved.bounds.x, 2220);
  assert.notEqual(userMoved.bounds.x, osAdjusted.bounds.x);
  assert.ok(
    userMoved.bounds.x + userMoved.bounds.width <=
      rightWorkArea.x + rightWorkArea.width,
  );
});

test("normalizing a dropped window moves its origin without resizing it", () => {
  // Dropped across the boundary between the two displays.
  assert.deepEqual(
    clampBoundsOriginToWorkArea(
      { x: 1700, y: 900, width: 1000, height: 800 },
      rightWorkArea,
    ),
    { x: 1920, y: 280, width: 1000, height: 800 },
  );
  // A window that already fits is returned unchanged.
  assert.deepEqual(
    clampBoundsOriginToWorkArea(
      { x: 2000, y: 100, width: 1000, height: 800 },
      rightWorkArea,
    ),
    { x: 2000, y: 100, width: 1000, height: 800 },
  );
  // Base bounds are user intent under ADR 0122, so a rect larger than the work
  // area keeps its size and is pinned to the top-left. Shrinking it here would
  // be persisted and could never be restored on a roomier display.
  assert.deepEqual(
    clampBoundsOriginToWorkArea(
      { x: 2000, y: 100, width: 2400, height: 1200 },
      rightWorkArea,
    ),
    { x: 1920, y: 0, width: 2400, height: 1200 },
  );
});

test("a drag onto a smaller display keeps the base size restorable", () => {
  const smallWorkArea = { x: 1920, y: 0, width: 1280, height: 800 };
  const base = { x: 100, y: 80, width: 1600, height: 900 };
  const opened = planWorkPanelReservation({
    baseBounds: base,
    workArea,
    requestedWidth: 420,
  });
  const droppedBounds = { ...opened.bounds, x: 2000, y: 60 };

  const adopted = reconcileBaseWindowBounds({
    baseBounds: base,
    lastAppliedBounds: opened.bounds,
    currentBounds: droppedBounds,
    displayTransition: "user-moved",
    reservation: opened.reservation,
  });
  const normalized = clampBoundsOriginToWorkArea(adopted, smallWorkArea);

  // The small display cannot supply the reservation, but the base size the user
  // chose survives, so returning to the large display restores it in full.
  assert.equal(normalized.width, 1600);
  assert.equal(normalized.height, 900);
  const constrained = planWorkPanelReservation({
    baseBounds: normalized,
    workArea: smallWorkArea,
    requestedWidth: 420,
  });
  assert.equal(constrained.reservation.width, 0);

  const restored = planWorkPanelReservation({
    baseBounds: baseWindowBounds(constrained.bounds, constrained.reservation),
    workArea,
    requestedWidth: 420,
  });
  assert.equal(restored.reservation.width, 320);
  assert.equal(
    baseWindowBounds(restored.bounds, restored.reservation).width,
    1600,
  );
});

test("reservation width parsing rejects coerced and malformed IPC input", () => {
  assert.equal(parseWorkPanelReservationWidth({ width: 0 }), 0);
  assert.equal(parseWorkPanelReservationWidth({ width: 244 }), 244);
  assert.equal(parseWorkPanelReservationWidth({ width: 720 }), 720);

  for (const input of [
    null,
    undefined,
    false,
    [],
    {},
    { width: "420" },
    { width: false },
    { width: 243 },
    { width: 720.5 },
    { width: 721 },
    { width: Number.NaN },
    { width: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(parseWorkPanelReservationWidth(input), null);
  }
});
