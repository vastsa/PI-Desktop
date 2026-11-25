import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWindowStateSync } from "../electron/main/window-state-sync.ts";
import { installMaximizedWindowChrome } from "../src/lib/maximized-window-chrome.ts";
import { readMainSource } from "./helpers/source-contracts.mjs";

const mainSource = await readMainSource();
class Caption { constructor(region = "drag") { this.region = region; } }
globalThis.Element = Caption;
const settle = () => new Promise(setImmediate);

function fixture() {
  const window = new EventEmitter();
  const timers = new Map();
  let timerId = 0;
  let maximized = true;
  let maximizeListener;
  const scheduler = {
    setTimeout(callback, delayMs) {
      assert.equal(delayMs, 300);
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const documentListeners = new Map();
  const document = {
    documentElement: { dataset: {} },
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    removeEventListener: (name) => documentListeners.delete(name),
  };
  const api = {
    windowControl: async () => ({ maximized }),
    onWindowMaximized(listener) {
      maximizeListener = listener;
      return () => { maximizeListener = null; };
    },
  };
  const disposeChrome = installMaximizedWindowChrome("darwin", document, {
    getComputedStyle: (target) => ({ getPropertyValue: () => target.region }),
  }, api);
  installWindowStateSync(
    window,
    () => maximizeListener?.({ maximized }),
    300,
    scheduler,
  );
  return {
    window,
    document,
    timers,
    setMaximized: (value) => { maximized = value; },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    clickCaption() {
      const event = {
        target: new Caption(),
        button: 0,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      documentListeners.get("dblclick")?.(event);
      return event;
    },
    dispose() { disposeChrome(); window.emit("closed"); },
  };
}

test("native fullscreen transitions resync stale macOS maximize chrome after settling", async () => {
  const f = fixture();
  await settle();
  assert.equal(f.document.documentElement.dataset.windowMaximized, "true");
  assert.equal(f.clickCaption().defaultPrevented, true);

  // AppKit can deliver the fullscreen event before isMaximized() reflects the
  // settled native state, and may not emit a separate unmaximize event.
  f.window.emit("enter-full-screen");
  f.setMaximized(false);
  assert.equal(f.document.documentElement.dataset.windowMaximized, "true");
  f.runTimers();
  assert.equal(f.document.documentElement.dataset.windowMaximized, "false");
  assert.equal(f.clickCaption().defaultPrevented, false);

  f.setMaximized(true);
  f.window.emit("maximize");
  assert.equal(f.document.documentElement.dataset.windowMaximized, "true");
  f.window.emit("leave-full-screen");
  f.setMaximized(false);
  f.runTimers();
  assert.equal(f.document.documentElement.dataset.windowMaximized, "false");
  assert.equal(f.clickCaption().defaultPrevented, false);
  f.dispose();
});

test("maximize and unmaximize events report native state immediately", async () => {
  const f = fixture();
  await settle();
  f.setMaximized(false);
  f.window.emit("unmaximize");
  assert.equal(f.document.documentElement.dataset.windowMaximized, "false");
  f.setMaximized(true);
  f.window.emit("maximize");
  assert.equal(f.document.documentElement.dataset.windowMaximized, "true");
  f.dispose();
});

test("fullscreen state resync timers are replaced and disposed on window close", () => {
  const f = fixture();
  f.window.emit("enter-full-screen");
  f.window.emit("leave-full-screen");
  assert.equal(f.timers.size, 1);
  f.dispose();
  assert.equal(f.timers.size, 0);
  f.runTimers();
  assert.equal(f.document.documentElement.dataset.windowMaximized, undefined);
});

test("Main retains fullscreen broadcasts and installs maximize resync", () => {
  assert.match(mainSource, /window\.on\("enter-full-screen", sendFullScreen\)/);
  assert.match(mainSource, /window\.on\("leave-full-screen", \(\) => \{\s*sendFullScreen\(\)/);
  assert.match(mainSource, /installWindowStateSync\(window, sendMaximized, windowBoundsSettleMs\)/);
});
