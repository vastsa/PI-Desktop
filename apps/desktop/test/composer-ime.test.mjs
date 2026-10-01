import { readComposerModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const inputSource = await readComposerModule("ComposerInput.tsx");
const draftSource = await readComposerModule("hooks/useComposerDraft.ts");
const modelMenuSource = await readComposerModule("hooks/useComposerModelMenu.ts");

const modifierSendCondition =
  /event\.key === "Enter"\s*&&\s*!event\.shiftKey\s*&&\s*\(enterToSend \|\| event\.metaKey \|\| event\.ctrlKey\)/;

function promptEditorKeyDown(source) {
  const start = source.indexOf("onKeyDown={(event: ReactKeyboardEvent");
  const end = source.indexOf("        />", start);
  assert.ok(start > -1 && end > start, "prompt editor keydown must exist");
  return source.slice(start, end);
}

test("enter-to-send ignores the IME confirm keystroke", () => {
  const handler = promptEditorKeyDown(inputSource);
  const guardIndex = handler.indexOf(
    "event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229",
  );
  const sendIndex = handler.search(modifierSendCondition);
  assert.ok(guardIndex > -1, "composer keydown must check IME composition");
  assert.ok(sendIndex > -1, "composer keydown must keep the send branch");
  assert.ok(
    guardIndex < sendIndex,
    "composition guard must run before the send branch",
  );
});

test("modifier Enter sends when Enter-to-send is disabled", () => {
  const handler = promptEditorKeyDown(inputSource);
  const sendIndex = handler.search(modifierSendCondition);
  const autocompleteIndex = handler.search(
    /\(event\.key === "Enter" \|\| event\.key === "Tab"\) && !event\.shiftKey/,
  );
  assert.ok(sendIndex > -1, "prompt editor must include the modifier send branch");
  assert.ok(
    autocompleteIndex > -1 && autocompleteIndex < sendIndex,
    "autocomplete Enter must run before the send branch",
  );
  assert.match(handler.slice(sendIndex), /onSubmit\(\);/);

  const modelMenu = modelMenuSource;
  assert.doesNotMatch(
    modelMenu.slice(0, modelMenu.indexOf("onCompositionStart")),
    modifierSendCondition,
    "model menu keydown must not own the composer send predicate",
  );
});

test("model menu keydown ignores IME composition keystrokes", () => {
  const handler = modelMenuSource.slice(
    modelMenuSource.indexOf("const onMenuKeyDown"),
    modelMenuSource.indexOf('event.key === "ArrowDown"'),
  );
  assert.match(
    handler,
    /event\.nativeEvent\.isComposing \|\| event\.nativeEvent\.keyCode === 229/,
    "menu navigation must bail out while an IME composition is active",
  );
});

test("an ideographic comma opens the slash menu from an empty draft (D405)", () => {
  const handler = draftSource.slice(
    draftSource.indexOf("const handleInput ="),
    draftSource.indexOf("removeChipByTokenRef", draftSource.indexOf("const handleInput =")),
  );
  assert.match(
    handler,
    /rewriteIdeographicCommaTrigger\(/,
    "the editable must route a committed 、 through the shared rewrite",
  );
  assert.match(
    handler,
    /valueRef\.current === ""/,
    "only a draft with nothing in it may be rewritten",
  );
  assert.match(
    handler,
    /pendingEditorCaretRef\.current = caret/,
    "the caret must land after the substituted slash",
  );
});

test("a dropped compositionend cannot leave the composer composing forever (#929)", () => {
  // A Windows Chinese IME can drop compositionend when the composing text is
  // deleted. The draft's `composing` flag is component state, so without a
  // recovery path the slash menu stays frozen until the composer unmounts.
  // An input event outside a composition is the browser telling us it is over.
  const handler = inputSource.slice(
    inputSource.indexOf("onInput={(event) => {"),
    inputSource.indexOf("onCompositionStart="),
  );
  assert.match(
    handler,
    /if \(!\(event\.nativeEvent as InputEvent\)\.isComposing\) onSettledInput\(\);/,
    "a settled input must clear the composing flag",
  );
  // It has to run before the draft update, so the very same input is judged
  // against a cleared flag rather than the stale one.
  assert.ok(
    handler.indexOf("onSettledInput()") < handler.indexOf("onInput(source, start)"),
    "the recovery must precede the draft update",
  );
});
