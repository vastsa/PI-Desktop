/**
 * #2433 / #2555: the composer's empty last line.
 *
 * Chromium drops the last break of a block, so a draft that ends with a newline
 * paints no line of its own and a caret left there resolves to the line above.
 * The editor paints one placeholder break after it instead: a node with no text,
 * counted as zero characters by every read, index and caret path, so nothing can
 * be selected, copied or typed and the draft string never changes.
 */
import assert from "node:assert/strict";
import { readComposerModule } from "./helpers/source-contracts.mjs";
import test from "node:test";

const [editor, draft, deletion] = await Promise.all([
  readComposerModule("editor.ts"),
  readComposerModule("hooks/useComposerDraft.ts"),
  readComposerModule("native-deletion.ts"),
]);

test("the empty last line is a placeholder break, not a character", () => {
  assert.match(editor, /const TAIL_PLACEHOLDER = "data-composer-tail";/);
  assert.match(editor, /function createTailPlaceholder\(\): HTMLBRElement \{/);
  assert.match(editor, /el\.appendChild\(createTailPlaceholder\(\)\);/);
  // The zero-width space this replaced was a real character: it could be
  // selected, copied, and some fonts render it as a space (#2555).
  assert.doesNotMatch(editor, /\\u200B/);
  assert.doesNotMatch(editor, /stripTailMarkers|markedTextLength|offsetForDraftIndex/);
});

test("every read, index and caret path counts the placeholder as nothing", () => {
  assert.match(editor, /if \(node\.nodeType === Node\.TEXT_NODE\) return \(node\.nodeValue \?\? ""\)\.length;/);
  assert.match(editor, /if \(isTailPlaceholder\(element\)\) return;/);
  assert.match(editor, /if \(isTailPlaceholder\(child\)\) continue;/);
  // The end-of-draft caret sits at the start of the empty line, before the break.
  assert.match(
    editor,
    /if \(isTailPlaceholder\(child\)\) \{[\s\S]*?point = \{ node: parent, offset: index \};/,
  );
});

test("the placeholder is re-synced after every commit and never rewritten into text", () => {
  assert.match(editor, /export function syncTailPlaceholder\(el: HTMLElement\): void \{/);
  assert.match(editor, /if \(el\.lastChild !== placeholder\) el\.appendChild\(placeholder\);/);
  // The final layout node may anchor native undo after a Backspace.
  assert.match(editor, /if \(placeholder !== el\.lastChild\) placeholder\.remove\(\);/);
  assert.match(draft, /if \(element\) syncTailPlaceholder\(element\);/);
  // Mutating a text node's value is what moved the caret off the tail (#2555).
  assert.doesNotMatch(editor, /nodeValue = /);
});

test("Chromium does not get to add a second newline for one Enter", () => {
  // A break command owns the draft: Chromium inserts the break plus a placeholder
  // newline after the caret, which reached the draft as one empty line too many.
  assert.match(deletion, /onInsertLineBreak/);
  assert.match(deletion, /event\.inputType === "insertLineBreak"/);
  assert.doesNotMatch(deletion, /syncTailPlaceholder/);
});

test("the end-of-draft break is one native edit, so undo takes both nodes", () => {
  assert.match(editor, /export function tailBreakFragment\(\): string \{/);
  assert.match(editor, /return `<br><br \$\{TAIL_PLACEHOLDER\}>`;/);
  // One edit inserts the real break and the placeholder, so Chromium records a
  // single undo step instead of a bare DOM mutation (#2588 follow-up).
  assert.match(draft, /document\.execCommand\("insertHTML", false, tailBreakFragment\(\)\)/);
  // The native edit is the primary path; the DOM fallback only covers a browser
  // that refuses insertHTML.
  assert.ok(draft.indexOf("execCommand") < draft.indexOf("range.insertNode"));
});
