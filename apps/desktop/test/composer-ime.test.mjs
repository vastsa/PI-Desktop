import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

test("enter-to-send ignores the IME confirm keystroke", () => {
  const guardIndex = composerSource.indexOf(
    "e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229",
  );
  const sendIndex = composerSource.indexOf(
    'e.key === "Enter" && !e.shiftKey && enterToSend',
  );
  assert.ok(guardIndex > -1, "composer keydown must check IME composition");
  assert.ok(sendIndex > -1, "composer keydown must keep the send branch");
  assert.ok(
    guardIndex < sendIndex,
    "composition guard must run before the send branch",
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
