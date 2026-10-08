import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
  installWindowShape,
  roundedWindowShape,
  setWindowCornerRadius,
} from "../electron/main/window-shape.ts";
import { setWindowFullScreen } from "../electron/main/window-fullscreen.ts";

test("default native window radius matches the global medium radius token", () => {
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const match = tokens.match(/^\s*--radius-md:\s*(\d+(?:\.\d+)?)px;/m);
  assert.ok(match, "the global medium radius token is defined");
  assert.equal(DEFAULT_WINDOW_CORNER_RADIUS, Number(match[1]));
});

test("global medium-radius shape cuts only the outer corner pixels", () => {
  const rects = roundedWindowShape(100, 80, DEFAULT_WINDOW_CORNER_RADIUS);
  assert.deepEqual(rects[0], { x: 9, y: 0, width: 82, height: 1 });
  assert.deepEqual(rects[1], { x: 9, y: 79, width: 82, height: 1 });
  assert.deepEqual(rects.at(-1), { x: 0, y: 12, width: 100, height: 56 });
  assert.deepEqual(roundedWindowShape(100, 80, 0), []);
});

test("shape follows resize and becomes rectangular in maximized or fullscreen states", () => {
  const window = new EventEmitter();
  let bounds = { x: 20, y: 30, width: 100, height: 80 };
  let maximized = false;
  let lastShape = null;
  window.getBounds = () => bounds;
  window.isDestroyed = () => false;
  window.isMaximized = () => maximized;
  window.isFullScreen = () => false;
  window.setFullScreen = (value) => window.emit(value ? "enter-full-screen" : "leave-full-screen");
  window.setShape = (rects) => { lastShape = rects; };
  const shape = installWindowShape(window);
  assert.deepEqual(lastShape[0], { x: 9, y: 0, width: 82, height: 1 });
  bounds = { ...bounds, width: 120 };
  window.emit("resize");
  assert.equal(lastShape[0].width, 102);
  maximized = true;
  window.emit("maximize");
  assert.deepEqual(lastShape, []);
  maximized = false;
  window.emit("unmaximize");
  assert.equal(lastShape[0].width, 102);
  setWindowFullScreen(window, true, true);
  assert.deepEqual(lastShape, []);
  setWindowFullScreen(window, false, true);
  assert.equal(lastShape[0].width, 102);
  assert.equal(shape.setRadius(100), 24);
  assert.equal(lastShape[0].width < 102, true);
  assert.equal(setWindowCornerRadius(window, 0), 0);
  assert.deepEqual(lastShape, []);
  assert.equal(setWindowCornerRadius(window, 4), 4);
  assert.equal(lastShape[0].width, 116);
  window.emit("closed");
  assert.equal(window.listenerCount("resize"), 0);
  assert.equal(setWindowCornerRadius(window, 8), null);
});
