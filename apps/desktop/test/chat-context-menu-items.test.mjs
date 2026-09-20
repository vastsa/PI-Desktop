import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const t = (key) => key;
const noop = () => {};
const actions = { copyText: noop, selectText: noop };

function loadMenuItems() {
  const file = new URL("../src/features/chat/transcript/menu-items.tsx", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "i18next": {},
    "../../../components/ContextMenu": {},
    "../../../components/icons": new Proxy({}, { get: () => () => null }),
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked menu-item dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const {
  userMessageMenuItems,
  assistantTurnMenuItems,
  conversationMenuItems,
} = loadMenuItems();

const ids = (items) => items.map((item) => item.id);

test("a user message menu offers copy, select, edit, and a separated delete", () => {
  const items = userMessageMenuItems({
    t,
    text: "Fix the crash",
    selectTarget: null,
    editable: true,
    running: false,
    revision: null,
    actions,
    onEdit: noop,
    onDelete: noop,
    onActivateRevision: noop,
  });
  assert.deepEqual(ids(items), ["copy", "select-text", "edit", "delete"]);
  assert.equal(items.find((item) => item.id === "edit").separatorBefore, true);
  assert.equal(items.find((item) => item.id === "delete").danger, true);
  assert.equal(items.find((item) => item.id === "delete").separatorBefore, true);
});

test("a session-relayed user message cannot be edited or deleted", () => {
  const items = userMessageMenuItems({
    t,
    text: "Review the changes",
    selectTarget: null,
    editable: false,
    running: false,
    revision: null,
    actions,
    onEdit: noop,
    onDelete: noop,
    onActivateRevision: noop,
  });
  assert.deepEqual(ids(items), ["copy", "select-text"]);
});

test("a running turn disables edit, delete, and revision navigation", () => {
  const items = userMessageMenuItems({
    t,
    text: "Try again",
    selectTarget: null,
    editable: true,
    running: true,
    revision: { count: 3, active: 2 },
    actions,
    onEdit: noop,
    onDelete: noop,
    onActivateRevision: noop,
  });
  assert.deepEqual(ids(items), [
    "copy",
    "select-text",
    "edit",
    "revision-previous",
    "revision-next",
    "delete",
  ]);
  for (const id of ["edit", "delete", "revision-previous", "revision-next"]) {
    assert.equal(items.find((item) => item.id === id).disabled, true, id);
  }
});

test("a completed assistant turn offers copy, select, regenerate, and branch", () => {
  const items = assistantTurnMenuItems({
    t,
    answer: "Patched main.ts.",
    selectTarget: null,
    complete: true,
    actions,
    onRegenerate: noop,
    onBranch: noop,
  });
  assert.deepEqual(ids(items), ["copy", "select-text", "regenerate", "branch"]);
  assert.equal(items.find((item) => item.id === "regenerate").separatorBefore, true);
});

test("a streaming assistant turn without a settled answer offers no items", () => {
  const items = assistantTurnMenuItems({
    t,
    answer: "",
    selectTarget: null,
    complete: false,
    actions,
    onRegenerate: noop,
    onBranch: noop,
  });
  assert.deepEqual(ids(items), []);
});

test("the conversation menu copies the thread and keeps scroll actions", () => {
  const items = conversationMenuItems({
    t,
    conversation: "You:\nHi",
    scrollRef: { current: null },
    contentRef: { current: null },
    actions,
    onReturnToLatest: noop,
  });
  assert.deepEqual(ids(items), [
    "copy-conversation",
    "select-conversation",
    "scroll-top",
    "scroll-bottom",
  ]);
  assert.equal(items.find((item) => item.id === "copy-conversation").disabled, false);
});

test("an empty conversation disables copy instead of writing a blank clipboard", () => {
  const items = conversationMenuItems({
    t,
    conversation: "",
    scrollRef: { current: null },
    contentRef: { current: null },
    actions,
    onReturnToLatest: noop,
  });
  assert.equal(items.find((item) => item.id === "copy-conversation").disabled, true);
});

test("copy on a speaking turn prefers the live selection", () => {
  const copied = [];
  const copyActions = {
    copyText: (text, selection) => copied.push({ text, selection }),
    selectText: noop,
  };
  const items = userMessageMenuItems({
    t,
    text: "Fix the crash",
    selectTarget: null,
    editable: true,
    running: false,
    revision: null,
    actions: copyActions,
    onEdit: noop,
    onDelete: noop,
    onActivateRevision: noop,
  });
  items.find((item) => item.id === "copy").onSelect("this line");
  assert.deepEqual(copied, [{ text: "Fix the crash", selection: "this line" }]);
});

test("copy conversation ignores a live selection", () => {
  const copied = [];
  const copyActions = {
    copyText: (text, selection) => copied.push({ text, selection }),
    selectText: noop,
  };
  const items = conversationMenuItems({
    t,
    conversation: "You:\nHi",
    scrollRef: { current: null },
    contentRef: { current: null },
    actions: copyActions,
    onReturnToLatest: noop,
  });
  items.find((item) => item.id === "copy-conversation").onSelect("this line");
  assert.deepEqual(copied, [{ text: "You:\nHi", selection: undefined }]);
});
