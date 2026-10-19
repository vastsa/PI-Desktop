import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hook = await readFile(
  new URL("../src/hooks/useSmoothText.ts", import.meta.url),
  "utf8",
);

test("smooth text caps renderer commits at 30 Hz and stops when caught up", () => {
  // Each commit reconciles and repaints the whole streaming tree, so the
  // reveal rate is capped well below the display refresh: matching a 120 Hz
  // panel buys nothing the eye can see and doubles the repaint rate.
  assert.match(hook, /const REVEAL_FRAME_MS = 1000 \/ 30;/);
  assert.match(hook, /if \(elapsed < REVEAL_FRAME_MS\)/);
  assert.match(hook, /if \(backlog <= 0\) \{[\s\S]*?rafRef\.current = null;/);
  assert.match(hook, /const exactAdvance = fractionalAdvanceRef\.current \+ speed \* dt/);
});
