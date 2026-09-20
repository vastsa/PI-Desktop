import { readComposerModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const [inputSource, deletionSource] = await Promise.all([
  readComposerModule("ComposerInput.tsx"),
  readComposerModule("native-deletion.ts"),
]);

test("composer input owns the native deletion guard", () => {
  assert.match(inputSource, /installComposerDeletionGuard\(editor\)/);
  assert.match(inputSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(deletionSource, /event\.inputType\.startsWith\("delete"\)/);
  assert.match(deletionSource, /event\.getTargetRanges\(\)/);
  assert.match(deletionSource, /historyRedo/);
  assert.match(deletionSource, /event\.isComposing/);
  assert.match(deletionSource, /placeholders\.has\(br\)/);
  assert.doesNotMatch(deletionSource, /trim\(\)/);
});
