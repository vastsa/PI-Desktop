import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
  installWindowShape,
  roundedWindowHitRegion,
  setWindowCornerRadius,
} from "../electron/main/window-shape.ts";
import { setWindowFullScreen } from "../electron/main/window-fullscreen.ts";

function makeWindow() {
  const window = new EventEmitter();
  let bounds = { x: 20, y: 30, width: 100, height: 80 };
  let contentBounds = { x: 0, y: 0, width: 100, height: 80 };
  let maximized = false;
  let borderRadius = null;
  let lastShape = null;
  const contentView = {
    getBounds: () => contentBounds,
    setBorderRadius: (radius) => { borderRadius = radius; },
  };
  window.contentView = contentView;
  window.getBounds = () => bounds;
  window.isDestroyed = () => false;
  window.isMaximized = () => maximized;
  window.isFullScreen = () => false;
  window.setFullScreen = (value) => window.emit(value ? "enter-full-screen" : "leave-full-screen");
  window.setShape = (rects) => { lastShape = rects; };
  return {
    window,
    contentView,
    setBounds(next) {
      bounds = next;
      contentBounds = { x: 0, y: 0, width: next.width, height: next.height };
    },
    setMaximized(value) { maximized = value; },
    get borderRadius() { return borderRadius; },
    get lastShape() { return lastShape; },
  };
}

function makeScreen(scaleFactor = 1) {
  const screen = new EventEmitter();
  screen.getDisplayMatching = () => ({ scaleFactor });
  return {
    screen,
    setScaleFactor(next) { scaleFactor = next; },
  };
}

test("default window radius matches the global medium radius token", () => {
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const match = tokens.match(/^\s*--radius-md:\s*(\d+(?:\.\d+)?)px;/m);
  assert.ok(match, "the global medium radius token is defined");
  assert.equal(DEFAULT_WINDOW_CORNER_RADIUS, Number(match[1]));
});

test("native hit region includes antialiased edge coverage for supported radii", () => {
  const defaultRegion = roundedWindowHitRegion(100, 80, DEFAULT_WINDOW_CORNER_RADIUS);
  assert.deepEqual(defaultRegion[0], { x: 7, y: 0, width: 86, height: 1 });
  assert.deepEqual(defaultRegion[1], { x: 7, y: 79, width: 86, height: 1 });
  assert.deepEqual(defaultRegion.at(-1), { x: 0, y: 12, width: 100, height: 56 });
  assert.deepEqual(roundedWindowHitRegion(100, 80, 0), []);
  assert.deepEqual(roundedWindowHitRegion(100, 80, 24)[0], {
    x: 17,
    y: 0,
    width: 66,
    height: 1,
  });
});

test("native hit region uses the actual content-view size", () => {
  const fixture = makeWindow();
  fixture.contentView.getBounds = () => ({ x: 0, y: 0, width: 96, height: 76 });

  installWindowShape(fixture.window, DEFAULT_WINDOW_CORNER_RADIUS);

  assert.deepEqual(fixture.lastShape[0], { x: 7, y: 0, width: 82, height: 1 });
  assert.deepEqual(fixture.lastShape.at(-1), { x: 0, y: 12, width: 96, height: 52 });
});

test("visible radius and native hit region follow size, DPI, and window state", () => {
  const fixture = makeWindow();
  const screen = makeScreen();
  let setShapeCalls = 0;
  const originalSetShape = fixture.window.setShape;
  fixture.window.setShape = (rects) => {
    setShapeCalls += 1;
    originalSetShape(rects);
  };

  const shape = installWindowShape(fixture.window, DEFAULT_WINDOW_CORNER_RADIUS, screen.screen);
  assert.equal(fixture.borderRadius, 12);
  assert.deepEqual(fixture.lastShape[0], { x: 7, y: 0, width: 86, height: 1 });

  fixture.setBounds({ x: 20, y: 30, width: 120, height: 90 });
  fixture.window.emit("resize");
  assert.equal(fixture.borderRadius, 12);
  assert.equal(fixture.lastShape[0].width, 106);

  screen.setScaleFactor(1.75);
  const callsBeforeDpiChange = setShapeCalls;
  screen.screen.emit("display-metrics-changed", {}, { scaleFactor: 1.75 }, ["scaleFactor"]);
  assert.equal(setShapeCalls, callsBeforeDpiChange + 1);
  assert.equal(fixture.borderRadius, 12);

  fixture.setMaximized(true);
  fixture.window.emit("maximize");
  assert.deepEqual(fixture.lastShape, []);
  assert.equal(fixture.borderRadius, 0);
  fixture.setMaximized(false);
  fixture.window.emit("unmaximize");
  assert.equal(fixture.borderRadius, 12);
  assert.equal(fixture.lastShape[0].width, 106);

  setWindowFullScreen(fixture.window, true, true);
  assert.deepEqual(fixture.lastShape, []);
  assert.equal(fixture.borderRadius, 0);
  setWindowFullScreen(fixture.window, false, true);
  assert.equal(fixture.borderRadius, 12);

  assert.equal(shape.setRadius(100), 24);
  assert.equal(fixture.borderRadius, 24);
  assert.equal(fixture.lastShape[0].width < 104, true);
  assert.equal(setWindowCornerRadius(fixture.window, 0), 0);
  assert.deepEqual(fixture.lastShape, []);
  assert.equal(fixture.borderRadius, 0);
  assert.equal(setWindowCornerRadius(fixture.window, 4), 4);
  assert.equal(fixture.borderRadius, 4);
  assert.equal(fixture.lastShape[0].width, 118);

  fixture.window.emit("closed");
  assert.equal(fixture.window.listenerCount("resize"), 0);
  assert.equal(fixture.window.listenerCount("move"), 0);
  assert.equal(screen.screen.listenerCount("display-metrics-changed"), 0);
  assert.equal(screen.screen.listenerCount("display-added"), 0);
  assert.equal(screen.screen.listenerCount("display-removed"), 0);
  assert.equal(setWindowCornerRadius(fixture.window, 8), null);
});

test("native region and rounded clip are re-applied after show or restore", () => {
  const fixture = makeWindow();
  const screen = makeScreen();
  let setShapeCalls = 0;
  let setBorderRadiusCalls = 0;
  fixture.window.setShape = () => { setShapeCalls += 1; };
  fixture.contentView.setBorderRadius = () => { setBorderRadiusCalls += 1; };

  installWindowShape(fixture.window, DEFAULT_WINDOW_CORNER_RADIUS, screen.screen);
  assert.equal(setShapeCalls, 1);
  assert.equal(setBorderRadiusCalls, 1);

  fixture.window.emit("show");
  assert.equal(setShapeCalls, 2);
  assert.equal(setBorderRadiusCalls, 2);
  fixture.window.emit("restore");
  assert.equal(setShapeCalls, 3);
  assert.equal(setBorderRadiusCalls, 3);

  fixture.window.emit("closed");
  fixture.window.emit("show");
  fixture.window.emit("restore");
  assert.equal(setShapeCalls, 3);
  assert.equal(setBorderRadiusCalls, 3);
});
