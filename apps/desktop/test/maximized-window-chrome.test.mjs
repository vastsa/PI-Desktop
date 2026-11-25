import assert from "node:assert/strict";
import test from "node:test";
import { installMaximizedWindowChrome } from "../src/lib/maximized-window-chrome.ts";

class Caption { constructor(region = "drag") { this.region = region; } }
globalThis.Element = Caption;
const settle = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function fixture({ platform = "darwin", initial = Promise.resolve({ maximized: true }) } = {}) {
  const listeners = new Map();
  const document = {
    documentElement: { dataset: {} },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
  const calls = [];
  const restore = deferred();
  let subscriber;
  const api = {
    windowControl(action) { calls.push(action); return action === "getState" ? initial : restore.promise; },
    onWindowMaximized(listener) { subscriber = listener; return () => { subscriber = null; }; },
  };
  const dispose = installMaximizedWindowChrome(platform, document, {
    getComputedStyle: (target) => ({ getPropertyValue: () => target.region }),
  }, api);
  return {
    document, calls, restore, dispose,
    update: (maximized) => subscriber?.({ maximized }),
    click(region = "drag", overrides = {}) {
      const event = { target: new Caption(region), button: 0, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...overrides };
      listeners.get("dblclick")?.(event);
      return event;
    },
  };
}

test("maximized caption double-click restores once; controls and normal windows remain native", async () => {
  const f = fixture();
  await settle();
  assert.equal(f.document.documentElement.dataset.windowMaximized, "true");
  assert.equal(f.click("no-drag").defaultPrevented, false);
  assert.equal(f.click("drag", { button: 2 }).defaultPrevented, false);
  assert.equal(f.click().defaultPrevented, true);
  f.click();
  assert.deepEqual(f.calls, ["getState", "toggleMaximize"]);
  f.restore.resolve({ maximized: false });
  await settle();
  assert.equal(f.document.documentElement.dataset.windowMaximized, "false");
  assert.equal(f.click().defaultPrevented, false);
  f.dispose();
  assert.equal(f.document.documentElement.dataset.windowMaximized, undefined);
});

test("a late initial query cannot overwrite a newer native maximize event", async () => {
  const initial = deferred();
  const f = fixture({ initial: initial.promise });
  f.update(true);
  initial.resolve({ maximized: false });
  await settle();
  assert.equal(f.document.documentElement.dataset.windowMaximized, "true");
  f.dispose();
});

test("a newer native event wins over a stale restore response", async () => {
  const f = fixture();
  await settle();
  f.click();
  f.update(false);
  f.update(true);
  f.restore.resolve({ maximized: false });
  await settle();
  assert.equal(f.document.documentElement.dataset.windowMaximized, "true");
  f.dispose();
});

test("unmount ignores outstanding queries and removes double-click handling", async () => {
  const initial = deferred();
  const f = fixture({ initial: initial.promise });
  f.dispose();
  initial.resolve({ maximized: true });
  await settle();
  assert.equal(f.document.documentElement.dataset.windowMaximized, undefined);
  f.click();
  assert.deepEqual(f.calls, ["getState"]);
});

for (const platform of ["win32", "linux"]) {
  test(`${platform}: native caption behavior is untouched`, async () => {
    const f = fixture({ platform });
    await settle();
    f.click();
    assert.deepEqual(f.calls, []);
    assert.equal(f.document.documentElement.dataset.windowMaximized, undefined);
    f.dispose();
  });
}
