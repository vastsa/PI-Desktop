/**
 * #2433 follow-up: Chromium gives an empty line a box but no caret box, so a
 * caret left on the last empty line resolves to the neighbouring line. A
 * trailing `<br>` adds a box but also a second caret position below it, which
 * reads as an extra line. The editor keeps a zero-width space on that line
 * instead, and every read path has to strip the character.
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

const editorPath = "../src/features/chat/composer/editor.ts";
const globals = { TAIL_MARKER: "\u200B" };
const stripTailMarkers = loadFunction(editorPath, "stripTailMarkers", globals);
const markedTextLength = loadFunction(editorPath, "markedTextLength", {
  ...globals,
  stripTailMarkers: (text) => stripTailMarkers(text),
});
const offsetForDraftIndex = loadFunction(editorPath, "offsetForDraftIndex", globals);

test("the zero-width marker never reaches the draft string", () => {
  assert.equal(stripTailMarkers("a\u200B"), "a");
  assert.equal(stripTailMarkers("\u200B"), "");
  assert.equal(stripTailMarkers("a\nb"), "a\nb");
  assert.equal(markedTextLength("a\u200B"), 1);
  assert.equal(markedTextLength("\u200B"), 0);
  assert.equal(markedTextLength("ab"), 2);
});

test("a caret named by draft index sits before the marker, where the box is", () => {
  // "ab\u200B" with the caret at the end: the DOM offset is the marker's index.
  assert.equal(offsetForDraftIndex("ab\u200B", 2), 2);
  assert.equal(offsetForDraftIndex("ab\u200B", 1), 1);
  assert.equal(offsetForDraftIndex("\u200B", 0), 0);
  assert.equal(offsetForDraftIndex("ab", 2), 2);
});

test("the editor model keeps, strips and paints around the tail marker", async () => {
  const editor = await readComposerModule("editor.ts");
  const draft = await readComposerModule("hooks/useComposerDraft.ts");
  const deletion = await readComposerModule("native-deletion.ts");

  // A zero-width space, never a break: a break adds a caret position below the
  // empty line, which is the extra line #2433's first fix introduced.
  assert.match(editor, /const TAIL_MARKER = "\\u200B";/);
  assert.doesNotMatch(editor, /data-composer-tail/);

  // Every read, index and caret path strips the character, because Chromium can
  // merge the marker into the neighbouring text node.
  assert.match(editor, /if \(node\.nodeType === Node\.TEXT_NODE\) return markedTextLength\(node\.nodeValue \?\? ""\);/);
  assert.match(editor, /out \+= stripTailMarkers\(node\.nodeValue \?\? ""\);/);
  assert.match(editor, /total \+= markedTextLength\(child\.nodeValue \?\? ""\);/);
  assert.match(
    editor,
    /point = \{ node: child, offset: offsetForDraftIndex\(child\.nodeValue \?\? "", remaining\) \};/,
  );

  // Painting gives an empty last line its caret box, and every commit keeps it.
  assert.match(editor, /function paintTailMarker\(el: HTMLElement, value: string\): void \{/);
  assert.match(editor, /el\.appendChild\(document\.createTextNode\(TAIL_MARKER\)\)/);
  assert.match(draft, /if \(element\) syncTailMarker\(element\);/);

  // The marker is a trailing character while the last line is empty and is
  // removed as soon as that line has content.
  assert.match(editor, /lastText\.nodeValue = `\$\{lastText\.nodeValue \?\? ""\}\$\{TAIL_MARKER\}`;/);
  assert.match(editor, /lastText\.nodeValue = stripTailMarkers\(lastText\.nodeValue \?\? ""\);/);

  // The invariant is restored after the event, never inside it: mutating the
  // editor while Chromium runs an editing command makes it insert twice.
  assert.doesNotMatch(deletion, /syncTailMarker/);
});
