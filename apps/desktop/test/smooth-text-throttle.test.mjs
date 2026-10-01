import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hook = await readFile(
  new URL("../src/hooks/useSmoothText.ts", import.meta.url),
  "utf8",
);

test("smooth text caps renderer commits at 60 Hz and stops when caught up", () => {
  assert.match(hook, /if \(elapsed < 1000 \/ 60\)/);
  assert.match(hook, /if \(backlog <= 0\) \{[\s\S]*?rafRef\.current = null;/);
  assert.match(hook, /const exactAdvance = fractionalAdvanceRef\.current \+ speed \* dt/);
});
