import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function harness() {
  const source = readFileSync(new URL("../electron/main/bootstrap/app-lifecycle.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("lifecycle.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["applyNativeThemeSource", "applyAppThemePreference", "resolveAppearance", "broadcastAppearance", "refreshSystemAppearance"]);
  const fragments = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) fragments.push(node.getText(ast));
    if (ts.isExpressionStatement(node) && /^(nativeTheme\.on\("updated"|app\.once\("will-quit")/.test(node.getText(ast))) fragments.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const nativeTheme = new EventEmitter();
  nativeTheme.themeSource = "system";
  nativeTheme.systemDark = false;
  Object.defineProperty(nativeTheme, "shouldUseDarkColors", { get: () => nativeTheme.themeSource === "dark" || (nativeTheme.themeSource === "system" && nativeTheme.systemDark) });
  const app = new EventEmitter();
  const state = { appThemePreference: "system", pluginPanelTheme: "light", updaterLocale: "en", broadcastAppearanceSignature: "" };
  const elements = new Map();
  const root = { dataset: {} };
  const callbacks = new Map();
  const html = readFileSync(new URL("../resources/plugins/pi.browser/views/browser.html", import.meta.url), "utf8");
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { documentElement: root, getElementById(id) {
      if (!elements.has(id)) elements.set(id, { addEventListener() {}, setAttribute() {}, getBoundingClientRect: () => ({ x: 0, y: 36, width: 400, height: 300 }) });
      return elements.get(id);
    } },
    window: { pluginBridge: { on: (name, fn) => callbacks.set(name, fn), invoke: async () => null }, matchMedia: () => ({ matches: !nativeTheme.shouldUseDarkColors }), addEventListener() {} },
    navigator: { language: "en" }, ResizeObserver: class { observe() {} },
  });
  const context = {
    nativeTheme, app, appearanceState: state, appState: state,
    isThemeColorScheme: value => value === "light" || value === "dark",
    plugins: { getThemes: () => [], broadcastEvent() {} },
    broadcastPluginPanelEvent: (name, value) => callbacks.get(name)?.(value),
    process: { platform: "linux" }, windowState: {}, state: {}, logger: { app() {} },
  };
  const code = ts.transpileModule(fragments.join("\n") + "\nglobalThis.apply=applyAppThemePreference;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, context);
  return { nativeTheme, app, root, apply: context.apply, state };
}

test("open Browser chrome follows OS light/dark changes without another settings write", async () => {
  const h = harness();
  await new Promise(setImmediate);
  h.apply("system");
  assert.equal(h.root.dataset.base, "light");
  for (const dark of [true, false]) {
    h.nativeTheme.systemDark = dark;
    h.nativeTheme.emit("updated");
    assert.equal(h.root.dataset.base, dark ? "dark" : "light");
    assert.equal(h.state.pluginPanelTheme, dark ? "dark" : "light");
  }
});

test("OS appearance changes preserve an explicit app palette", async () => {
  const h = harness();
  await new Promise(setImmediate);
  h.apply("dark");
  h.nativeTheme.emit("updated");
  assert.equal(h.root.dataset.base, "dark");
});

test("application shutdown removes its native appearance listener", () => {
  const h = harness();
  assert.equal(h.nativeTheme.listenerCount("updated"), 1);
  h.app.emit("will-quit");
  assert.equal(h.nativeTheme.listenerCount("updated"), 0);
});
