import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  clampWorkPanelTabMenuPointToDip,
  parseWorkPanelTabMenuRequest,
  waitForNativeMenuResult,
} = await import("../electron/main/work-panel-tab-menu.ts");

const validRequest = {
  closeTabLabel: "Close tab",
  closeOtherTabsLabel: "Close other tabs",
  closeAllTabsLabel: "Close all tabs",
  canCloseOthers: true,
  x: 20,
  y: 40,
};

test("work-panel menu request accepts and sanitizes bounded labels", () => {
  assert.deepEqual(
    parseWorkPanelTabMenuRequest({
      ...validRequest,
      closeTabLabel: "  Close\n\tthis tab  ",
      closeOtherTabsLabel: "x".repeat(300),
    }),
    {
      ...validRequest,
      closeTabLabel: "Close this tab",
      closeOtherTabsLabel: "x".repeat(256),
    },
  );
});

test("work-panel menu request rejects malformed labels, states, and coordinates", () => {
  const invalidRequests = [
    null,
    [],
    { ...validRequest, closeTabLabel: " \n\t " },
    { ...validRequest, closeTabLabel: "x".repeat(1025) },
    { ...validRequest, canCloseOthers: 1 },
    { ...validRequest, x: Number.NaN },
    { ...validRequest, x: Number.POSITIVE_INFINITY },
    { ...validRequest, x: -1 },
    { ...validRequest, y: "40" },
  ];

  for (const request of invalidRequests) {
    assert.equal(parseWorkPanelTabMenuRequest(request), null);
  }
});

test("work-panel menu point scales CSS coordinates to window DIPs before clamping", () => {
  assert.deepEqual(
    clampWorkPanelTabMenuPointToDip(validRequest, 1.5, 100, 100),
    { x: 30, y: 60 },
  );
  assert.deepEqual(
    clampWorkPanelTabMenuPointToDip({ x: 80, y: 90 }, 1.5, 100, 100),
    { x: 99, y: 99 },
  );
  assert.deepEqual(
    clampWorkPanelTabMenuPointToDip(validRequest, Number.NaN, 100, 100),
    { x: 20, y: 40 },
  );
});

test("native menu result settles on window close and removes its listener", async () => {
  let closedListener;
  const listeners = new Set();
  const window = {
    once(event, listener) {
      assert.equal(event, "closed");
      closedListener = listener;
      listeners.add(listener);
    },
    removeListener(event, listener) {
      assert.equal(event, "closed");
      listeners.delete(listener);
    },
  };
  let onMenuClosed;
  const pending = waitForNativeMenuResult(
    window,
    (listener) => { onMenuClosed = listener; },
    () => "closeTab",
  );

  assert.equal(listeners.size, 1);
  closedListener();
  assert.equal(await pending, null);
  assert.equal(listeners.size, 0);
  onMenuClosed();
  assert.equal(listeners.size, 0);
});

test("native menu popup errors reject and clean up the window listener", async () => {
  let closedListener;
  let listenerCount = 0;
  const window = {
    once(_event, listener) {
      closedListener = listener;
      listenerCount += 1;
    },
    removeListener(_event, listener) {
      assert.equal(listener, closedListener);
      listenerCount -= 1;
    },
  };

  await assert.rejects(
    waitForNativeMenuResult(window, () => { throw new Error("popup failed"); }, () => null),
    /popup failed/,
  );
  assert.equal(listenerCount, 0);
});
