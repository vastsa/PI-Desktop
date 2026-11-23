/**
 * #2433: the empty last line has no box of its own, so Chromium types the next
 * keystroke one line up. The editor keeps a placeholder break on that line and
 * every read path has to ignore it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readComposerModule } from "./helpers/source-contracts.mjs";

function loadFunction(path, name, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const tree = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(node, name);
  const code = ts.transpileModule(node.getText(tree).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(`${code}\n${name};`, globals);
}

const nodeConstants = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
const isTailPlaceholder = loadFunction("../src/features/chat/composer/editor.ts", "isTailPlaceholder", {
  Node: nodeConstants,
  TAIL_PLACEHOLDER_ATTRIBUTE: "data-composer-tail",
});
const editorNodeLength = loadFunction("../src/features/chat/composer/editor.ts", "editorNodeLength", {
  Node: nodeConstants,
  isChipElement: () => false,
  isTailPlaceholder: (node) => isTailPlaceholder(node),
});

const placeholder = {
  nodeType: 1,
  tagName: "BR",
  hasAttribute: (name) => name === "data-composer-tail",
};
const realBreak = { nodeType: 1, tagName: "BR", hasAttribute: () => false };
const text = (value) => ({ nodeType: 3, nodeValue: value, childNodes: [] });

test("only the marked break is a tail placeholder, and it has no length", () => {
  assert.equal(isTailPlaceholder(placeholder), true);
  assert.equal(isTailPlaceholder(realBreak), false);
  assert.equal(isTailPlaceholder(text("\n")), false);
  assert.equal(editorNodeLength(placeholder), 0);
  assert.equal(editorNodeLength(realBreak), 1);
  assert.equal(editorNodeLength(text("ab")), 2);
});

test("the editor model places, reads and paints around the tail placeholder", async () => {
  const editor = await readComposerModule("editor.ts");
  const draft = await readComposerModule("hooks/useComposerDraft.ts");
  const deletion = await readComposerModule("native-deletion.ts");

  // Reading and indexing skip it, so the draft string never grows a newline.
  assert.match(editor, /if \(isTailPlaceholder\(element\)\) return;/);
  assert.match(editor, /} else if \(isTailPlaceholder\(child\)\) \{/);

  // A caret placed by draft index lands before it, never on it.
  assert.match(editor, /if \(isTailPlaceholder\(child\)\) \{\n\s+\/\/ Not a draft position/);
  assert.match(editor, /const placeholder = Array\.from\(el\.childNodes\)\.findIndex\(isTailPlaceholder\);/);

  // Painting gives an empty last line its box, and every commit keeps it.
  assert.match(editor, /paintTailPlaceholder\(el, value\);/);
  assert.match(editor, /if \(value\.endsWith\("\\n"\)\) el\.appendChild\(buildTailPlaceholder\(\)\);/);
  assert.match(draft, /useLayoutEffect\(\(\) => \{\n\s+const element = ref\.current;\n\s+if \(element\) syncTailPlaceholder\(element\);/);

  // The invariant is restored after the event, never inside it: mutating the
  // editor while Chromium runs an editing command makes it insert twice.
  assert.doesNotMatch(deletion, /syncTailPlaceholder/);
});
