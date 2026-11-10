import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Runs the production Browser chrome script; the plugin bridge is the boundary.
const html = readFileSync(new URL("../resources/plugins/pi.browser/views/browser.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "browser chrome script exists");
assert.match(html, /id="mute"[^>]*aria-pressed="false"/, "the toolbar exposes a toggle button");

function render(locale) {
  const elements = new Map();
  const callbacks = new Map();
  const calls = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      id, disabled: false, hidden: false, value: "", textContent: "", title: "",
      handlers: new Map(),
      addEventListener(name, fn) { this.handlers.set(name, fn); },
      setAttribute(name, value) { this[name] = value; },
      getBoundingClientRect: () => ({ x: 0, y: 36, width: 400, height: 300 }),
    });
    return elements.get(id);
  };
  const bridge = {
    on(name, fn) { callbacks.set(name, fn); },
    invoke(name, payload) {
      calls.push({ name, payload });
      if (name === "app.getAppearance") return Promise.resolve({ locale, base: "light" });
      if (name === "browser.getState" || name === "browser.navigate") return Promise.resolve(null);
      return Promise.resolve();
    },
  };
  runInNewContext(script, {
    document: { getElementById: element, documentElement: { dataset: {}, lang: "" } },
    window: { pluginBridge: bridge, matchMedia: () => ({ matches: true }), addEventListener() {} },
    navigator: { language: locale },
    ResizeObserver: class { observe() {} },
  });
  return { element, state: (value) => callbacks.get("browser:state")(value), calls };
}

// Objects built inside the script's VM realm carry that realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const page = {
  sessionId: "session-a", tabId: "tab-1", url: "https://fixture.invalid/video",
  title: "video", isLoading: false, canGoBack: false, canGoForward: false,
};

test("a user mutes and unmutes the current tab from the toolbar", async () => {
  const view = render("en");
  await new Promise(setImmediate);
  const mute = view.element("mute");
  assert.equal(mute.disabled, true, "nothing to mute before a page opens");

  view.state({ ...page, audible: true });
  assert.equal(mute.disabled, false);
  assert.equal(mute.title, "Mute tab");
  assert.equal(mute["aria-pressed"], "false");
  assert.equal(mute["data-audible"], "true");

  mute.handlers.get("click")();
  assert.deepEqual(plain(view.calls.at(-1)), {
    name: "browser.action",
    payload: { action: "mute", sessionId: "session-a", tabId: "tab-1" },
  });

  view.state({ ...page, audible: true, audioMuted: true });
  assert.equal(mute.title, "Unmute tab");
  assert.equal(mute["aria-label"], "Unmute tab");
  assert.equal(mute["aria-pressed"], "true");

  mute.handlers.get("click")();
  assert.equal(view.calls.at(-1).payload.action, "unmute");
});

test("switching to another tab shows that tab's own mute state", async () => {
  const view = render("en");
  await new Promise(setImmediate);
  view.state({ ...page, audioMuted: true });
  view.state({ ...page, tabId: "tab-2", url: "https://fixture.invalid/other" });
  const mute = view.element("mute");
  assert.equal(mute["aria-pressed"], "false");
  assert.equal(mute.title, "Mute tab");
  mute.handlers.get("click")();
  assert.deepEqual(plain(view.calls.at(-1).payload), { action: "mute", sessionId: "session-a", tabId: "tab-2" });
});

test("the mute control is labelled in Chinese", async () => {
  const view = render("zh-CN");
  await new Promise(setImmediate);
  view.state(page);
  assert.equal(view.element("mute").title, "静音此标签页");
  view.state({ ...page, audioMuted: true });
  assert.equal(view.element("mute").title, "取消静音");
});
