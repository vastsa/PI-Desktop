import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

const modifierSendCondition =
  /e\.key === "Enter"\s*&&\s*!e\.shiftKey\s*&&\s*\(enterToSend \|\| e\.metaKey \|\| e\.ctrlKey\)/;

function promptEditorKeyDown(source) {
  const start = source.indexOf("onCompositionStart={() => setComposing(true)}");
  const end = source.indexOf("composer-toolbar", start);
  assert.ok(start > -1 && end > start, "prompt editor keydown must exist");
  return source.slice(start, end);
}

test("enter-to-send ignores the IME confirm keystroke", () => {
  const handler = promptEditorKeyDown(composerSource);
  const guardIndex = handler.indexOf(
    "e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229",
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
  const handler = promptEditorKeyDown(composerSource);
  const sendIndex = handler.search(modifierSendCondition);
  const autocompleteIndex = handler.search(
    /\(e\.key === "Enter" \|\| e\.key === "Tab"\) && !e\.shiftKey/,
  );
  assert.ok(sendIndex > -1, "prompt editor must include the modifier send branch");
  assert.ok(
    autocompleteIndex > -1 && autocompleteIndex < sendIndex,
    "autocomplete Enter must run before the send branch",
  );
  assert.match(handler.slice(sendIndex), /void submit\(\);/);

  const modelMenu = composerSource.slice(
    composerSource.indexOf("const onModelThinkingMenuKeyDown"),
    composerSource.indexOf("composer-toolbar"),
  );
  assert.doesNotMatch(
    modelMenu.slice(0, modelMenu.indexOf("onCompositionStart")),
    modifierSendCondition,
    "model menu keydown must not own the composer send predicate",
  );
});

test("model menu keydown ignores IME composition keystrokes", () => {
  const handler = composerSource.slice(
    composerSource.indexOf("const onModelThinkingMenuKeyDown"),
    composerSource.indexOf('e.key === "ArrowDown"'),
  );
  assert.match(
    handler,
    /e\.nativeEvent\.isComposing \|\| e\.nativeEvent\.keyCode === 229/,
    "menu navigation must bail out while an IME composition is active",
  );
});

test("an ideographic comma opens the slash menu from an empty draft (D405)", () => {
  const handler = composerSource.slice(
    composerSource.indexOf("onInput={(e) => {"),
    composerSource.indexOf("onCompositionStart={() => setComposing(true)}"),
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
    /pendingEditorCaretRef\.current = start/,
    "the caret must land after the substituted slash",
  );
});
