import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the real component's handlers/effects without Electron or a DOM
// dependency. This is not a browser layout or end-to-end test.
const source = await readFile(new URL("../src/components/ResponseAnnotationDialog.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function mount({ previousFocus } = {}) {
  const effects = [];
  const hooks = [];
  const listeners = new Map();
  let cursor = 0;
  let tree;
  let closed = 0;
  let saved;
  const document = { body: { style: { overflow: "auto" }, isConnected: true, focus() {} } };
  document.activeElement = previousFocus ?? document.body;
  if (previousFocus) previousFocus.focus = () => { document.activeElement = previousFocus; };
  const composer = { focus() { document.activeElement = composer; } };
  document.querySelector = (selector) => selector.includes('[contenteditable="true"]') ? composer : null;
  const state = {
    activeSessionId: "s1",
    responseAnnotationEditor: { sessionId: "s1", messageId: "m1", text: "$x^2$", annotationId: null, comment: "" },
    saveResponseAnnotationEditor: (value) => { saved = value; },
    closeResponseAnnotationEditor: () => { closed++; },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: {
      useEffect: (effect) => { effects.push(effect); },
      useRef: () => hooks[cursor++] ??= { current: null },
      useState: (initial) => {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], (value) => { hooks[index] = value; }];
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-dom": { createPortal: (node) => node },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../stores/app-store": { useAppStore: (select) => select(state) },
    "./ui": { Button: "button", TooltipButton: "button" },
    "./icons": { IconChat: "svg", IconClose: "svg" },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports, require: (id) => { assert.ok(id in modules, id); return modules[id]; },
    document,
    window: {
      addEventListener: (name, handler, capture) => {
        if (name === "keydown") assert.equal(capture, true, "modal keyboard handling must precede app shortcuts");
        listeners.set(name, handler);
      },
      removeEventListener: (name) => listeners.delete(name),
    },
    requestAnimationFrame: (callback) => { effects.push(callback); return 1; },
    cancelAnimationFrame() {},
  });
  function nodes(node = tree) {
    if (!node || typeof node !== "object") return [];
    return [node, ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child ?? null))];
  }
  function render() {
    cursor = 0;
    const component = exports.ResponseAnnotationDialog();
    tree = component.type(component.props);
    const all = nodes();
    for (const node of all) {
      node.isConnected = true;
      node.focus = () => { document.activeElement = node; };
      node.setSelectionRange = () => {};
      node.value = node.props.value ?? "";
      node.querySelectorAll = () => all.filter((item) => item.type === "button" || item.type === "textarea");
      if (node.props.ref) node.props.ref.current = node;
    }
  }
  render();
  const cleanups = [];
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  for (const frame of effects.splice(0)) frame();
  return {
    nodes, render, document, composer,
    renderHost: () => exports.ResponseAnnotationDialog(),
    state,
    get closed() { return closed; },
    get saved() { return saved; },
    key: (overrides) => {
      const event = { key: "Escape", preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...overrides };
      listeners.get("keydown")(event);
      return event;
    },
    unmount: () => { for (const cleanup of cleanups) cleanup(); },
  };
}

test("the mounted editor shows the excerpt, focuses the comment and saves typed content", () => {
  const view = mount();
  assert.ok(view.nodes().some((node) => node.props.role === "dialog"));
  assert.equal(view.nodes().find((node) => node.type === "blockquote").props.children, "$x^2$");
  const input = view.nodes().find((node) => node.type === "textarea");
  assert.equal(view.document.activeElement, input);
  input.props.onChange({ target: { value: "请解释这一步" } });
  view.render();
  view.nodes().find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(view.saved, "请解释这一步");
  assert.equal(view.closed, 0);
});

test("Enter saves the live comment, Shift+Enter inserts a newline, and IME Enter never saves", () => {
  const view = mount();
  const input = view.nodes().find((node) => node.type === "textarea");
  const key = (overrides = {}) => {
    const event = {
      key: "Enter", nativeEvent: {}, currentTarget: { value: "最新评价\n第二行" },
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; }, ...overrides,
    };
    input.props.onKeyDown?.(event);
    return event;
  };
  for (const event of [
    { shiftKey: true }, { nativeEvent: { isComposing: true } },
    { nativeEvent: { keyCode: 229 } }, { key: "a" },
  ]) {
    assert.equal(key(event).prevented, undefined, "typing and IME keep their native behavior");
    assert.equal(view.saved, undefined);
  }
  assert.equal(key({ repeat: true }).prevented, true);
  assert.equal(view.saved, undefined, "holding Enter must not repeat a save");
  const enter = key();
  assert.equal(view.saved, "最新评价\n第二行", "save the DOM value, not stale React state");
  assert.equal(enter.prevented, true);
  assert.equal(enter.stopped, true);
  assert.equal(view.closed, 0);
});

test("IME Escape keeps the editor open; ordinary Escape is owned by the dialog", () => {
  const view = mount();
  view.key({ isComposing: true });
  view.key({ keyCode: 229 });
  assert.equal(view.closed, 0, "IME candidate cancellation must not discard the comment");
  const event = view.key({});
  assert.equal(view.closed, 1);
  assert.equal(event.stopped, true, "Escape must not also reach application shortcuts");
});

test("only a press starting on the backdrop dismisses, not a selection drag ending there", () => {
  const view = mount();
  const backdrop = view.nodes()[0];
  backdrop.props.onClick?.({ target: backdrop, currentTarget: backdrop });
  assert.equal(view.closed, 0, "a synthesized click after dragging text must not discard it");
  backdrop.props.onPointerDown({ target: {}, currentTarget: backdrop });
  assert.equal(view.closed, 0);
  backdrop.props.onPointerDown({ target: backdrop, currentTarget: backdrop, preventDefault() {} });
  assert.equal(view.closed, 1);
});

test("Tab stays inside the dialog and Cancel never saves", () => {
  const view = mount();
  const controls = view.nodes().filter((node) => node.type === "button" || node.type === "textarea");
  controls.at(-1).focus();
  view.key({ key: "Tab" });
  assert.equal(view.document.activeElement, controls[0]);
  view.key({ key: "Tab", shiftKey: true });
  assert.equal(view.document.activeElement, controls.at(-1));
  controls.find((node) => node.props.children === "common.cancel").props.onClick();
  assert.equal(view.closed, 1);
  assert.equal(view.saved, undefined);
});

test("the host renders nothing after switching to another session", () => {
  const view = mount();
  view.state.activeSessionId = "s2";
  assert.equal(view.renderHost(), null);
});

test("closing an editor opened from the list restores its connected trigger", () => {
  const trigger = { isConnected: true };
  const view = mount({ previousFocus: trigger });
  view.unmount();
  assert.equal(view.document.activeElement, trigger);
});

test("closing from the selection overlay restores focus to the rich composer", () => {
  const view = mount();
  view.unmount();
  assert.equal(view.document.activeElement, view.composer);
  assert.equal(view.document.body.style.overflow, "auto");
});
