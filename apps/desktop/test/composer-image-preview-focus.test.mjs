import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/chat/composer/hooks/useComposerImagePreview.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("preview.ts", source, ts.ScriptTarget.Latest, true);
let openCallback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "open") openCallback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(openCallback);
const code = ts.transpileModule(`(${openCallback.getText(tree)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const document = { activeElement: null };
  class Element {
    isConnected = true;
    focus() { document.activeElement = this; }
    contains(node) { return node === this || (this === editor && node === chip); }
    closest() { return null; }
  }
  const editor = new Element(), chip = new Element();
  document.activeElement = chip;
  const range = { commonAncestorContainer: editor };
  let restoredRange;
  const selection = {
    rangeCount: 1, getRangeAt: () => ({ cloneRange: () => range }),
    removeAllRanges() { restoredRange = undefined; },
    // Chromium focuses the editing host when a selection is installed inside it.
    addRange(value) { restoredRange = value; editor.focus(); },
  };
  const state = { activeSessionId: "focus-session", workspace: { path: "/synthetic/project" } };
  let request;
  const open = vm.runInNewContext(code, {
    document, window: { getSelection: () => selection }, HTMLElement: Element,
    editorRef: { current: editor }, useAppStore: { getState: () => state },
    setRequest(value) { request = value; },
  });
  open({ id: "image", sessionId: "focus-session" });
  return { document, editor, chip, state, request, range, restoredRange: () => restoredRange };
}

test("closing an image preview restores the selection and original control focus", () => {
  const run = fixture();
  run.document.activeElement = null;
  run.request.restoreFocus();
  assert.equal(run.restoredRange(), run.range);
  assert.equal(run.document.activeElement, run.chip, "selection restoration must not steal the final control focus");
});

for (const changed of ["session", "project"]) {
  test(`a preview from another ${changed} cannot restore stale focus or selection`, () => {
    const run = fixture();
    if (changed === "session") run.state.activeSessionId = "other";
    else run.state.workspace.path = "/synthetic/other";
    run.document.activeElement = null;
    run.request.restoreFocus();
    assert.equal(run.document.activeElement, null);
    assert.equal(run.restoredRange(), undefined);
  });
}
