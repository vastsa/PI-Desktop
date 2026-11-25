import { readComposerModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const [inputSource, deletionSource] = await Promise.all([
  readComposerModule("ComposerInput.tsx"),
  readComposerModule("native-deletion.ts"),
]);

test("composer input owns the native deletion guard", () => {
  assert.match(inputSource, /installComposerDeletionGuard\(editor, \(\) => insertNewlineRef\.current\(\)\)/);
  assert.match(inputSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(deletionSource, /event\.inputType\.startsWith\("delete"\)/);
  assert.match(deletionSource, /event\.getTargetRanges\(\)/);
  assert.match(deletionSource, /historyRedo/);
  assert.match(deletionSource, /event\.isComposing/);
  assert.match(deletionSource, /placeholders\.has\(br\)/);
  assert.doesNotMatch(deletionSource, /trim\(\)/);
});

test("one Enter is one newline, owned by the editor at the draft end only", () => {
  // Chromium adds a second, layout-only newline when the caret ends the block, so
  // a draft would gain an empty line the user did not ask for (#2555).
  assert.match(deletionSource, /event\.inputType === "insertLineBreak" \|\| event\.inputType === "insertParagraph"/);
  assert.match(deletionSource, /atDraftEnd\(\)/);
  assert.match(deletionSource, /editorSelectionRange\(editor\)\.end === readEditorValue\(editor\)\.length/);
  assert.match(deletionSource, /event\.preventDefault\(\);\n\s+onInsertLineBreak\(\);/);
  // Paragraph boundaries must not introduce uncounted block wrappers.
  assert.match(deletionSource, /editor\.ownerDocument\.execCommand\("insertLineBreak"\)/);
  // React never dispatches the synthetic beforeinput event, so the guard owns it.
  assert.doesNotMatch(inputSource, /onBeforeInput/);
});
