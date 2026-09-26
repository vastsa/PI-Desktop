import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = readFileSync(new URL("../resources/plugins/pi.browser/views/browser.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "browser chrome script exists");

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
  return { element, callbacks, calls };
}

for (const [locale, expected] of [
  ["en", "Only existing files inside this project's workspace can be opened."],
  ["zh-CN", "只能打开此项目工作区内已存在的文件。"],
]) {
  test(`address bar explains denied local files in ${locale}`, async () => {
    const view = render(locale);
    await new Promise(setImmediate);
    const url = "file:///tmp/demo.html";
    view.element("url").value = url;
    view.element("form").handlers.get("submit")({ preventDefault() {} });
    assert.equal(view.calls.findLast((call) => call.name === "browser.navigate")?.payload.url, url);
    view.callbacks.get("browser:state")({ url, loadError: "LOCAL_FILE_NOT_ALLOWED" });
    assert.equal(view.element("empty").hidden, false);
    assert.equal(view.element("empty-body").textContent, expected);
    assert.equal(view.element("url").value, url);
    assert.equal(view.calls.at(-1).payload.visible, false);
  });
}
