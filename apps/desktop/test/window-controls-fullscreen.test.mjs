import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/WindowControls.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  fileName: "WindowControls.tsx",
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
});

// Run the real component against the native IPC edge with deterministic hooks.
function mount(initialState = { maximized: false, fullScreen: false }) {
  const slots = [];
  const effects = [];
  const listeners = new Map();
  const calls = [];
  let cursor = 0;
  let initialized = false;
  let resolveState;
  const stateReply = new Promise((resolve) => { resolveState = resolve; });
  const subscribe = (name) => (listener) => {
    listeners.set(name, listener);
    return () => listeners.delete(name);
  };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: {
      useState(value) {
        const index = cursor++;
        if (!initialized) slots[index] = value;
        return [slots[index], (next) => { slots[index] = next; }];
      },
      useEffect(effect) { if (!initialized) effects.push(effect); },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: (_key, fallback) => fallback }) },
    "../lib/api": {
      api: {
        windowControl(action) {
          calls.push(action);
          return action === "getState" ? stateReply : Promise.resolve(initialState);
        },
        nativeMenuAction(action) {
          calls.push(action);
          return Promise.resolve(initialState);
        },
        onWindowMaximized: subscribe("maximized"),
        onWindowFullScreen: subscribe("fullScreen"),
      },
    },
    "./icons": Object.fromEntries(["IconClose", "IconCopy", "IconMinus", "IconSquare"].map((icon) => [icon, icon])),
    "./ui": { TooltipButton: "TooltipButton" },
  };
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    window: { piDesktop: { platform: "win32" } },
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`);
      return imports[id];
    },
  });
  const render = () => { cursor = 0; return exports.WindowControls(); };
  render();
  initialized = true;
  const cleanup = effects.map((effect) => effect());
  return {
    calls,
    listeners,
    button: () => render().props.children[1],
    emit(name, value) { listeners.get(name)?.({ [name]: value }); },
    async resolveInitialState() { resolveState(initialState); await stateReply; },
    unmount() { cleanup.forEach((dispose) => dispose?.()); },
  };
}

function expectControl(fixture, restored) {
  const { props } = fixture.button();
  assert.equal(props.children.type, restored ? "IconCopy" : "IconSquare");
  assert.equal(props.tooltip, restored ? "Restore" : "Maximize");
  assert.equal(props.ariaLabel, props.tooltip);
}

test("mounting while fullscreen presents the restore control and exits fullscreen on click", async () => {
  const fixture = mount({ maximized: false, fullScreen: true });
  await fixture.resolveInitialState();
  expectControl(fixture, true);
  fixture.button().props.onClick();
  assert.deepEqual(fixture.calls, ["getState", "toggleFullScreen"]);
  fixture.unmount();
});

test("F11 enter/leave updates the glyph, tooltip, and accessible name", async () => {
  const fixture = mount();
  await fixture.resolveInitialState();
  expectControl(fixture, false);
  fixture.emit("fullScreen", true);
  expectControl(fixture, true);
  fixture.emit("fullScreen", false);
  expectControl(fixture, false);
  fixture.button().props.onClick();
  assert.deepEqual(fixture.calls, ["getState", "toggleMaximize"]);
  fixture.unmount();
});

test("fullscreen exits back to maximized without showing the maximize glyph", async () => {
  const fixture = mount({ maximized: true, fullScreen: false });
  await fixture.resolveInitialState();
  fixture.emit("fullScreen", true);
  fixture.emit("maximized", false);
  expectControl(fixture, true);
  fixture.emit("maximized", true);
  fixture.emit("fullScreen", false);
  expectControl(fixture, true);
  fixture.emit("maximized", false);
  expectControl(fixture, false);
  fixture.unmount();
});

test("unmount disposes both native event subscriptions and ignores a pending initial state", async () => {
  const fixture = mount({ maximized: true, fullScreen: true });
  assert.deepEqual([...fixture.listeners.keys()].sort(), ["fullScreen", "maximized"]);
  fixture.unmount();
  assert.equal(fixture.listeners.size, 0);
  await fixture.resolveInitialState();
  expectControl(fixture, false);
});
