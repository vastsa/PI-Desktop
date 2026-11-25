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

test("one Enter is one newline, owned by the editor", () => {
  // Chromium inserts the break plus a placeholder newline after the caret, so a
  // draft would gain an empty line the user did not ask for (#2555).
  assert.match(deletionSource, /event\.inputType === "insertLineBreak" \|\| event\.inputType === "insertParagraph"/);
  assert.match(deletionSource, /event\.preventDefault\(\);\n\s+onInsertLineBreak\(\);/);
  // React never dispatches the synthetic beforeinput event, so the guard owns it.
  assert.doesNotMatch(inputSource, /onBeforeInput/);
});
