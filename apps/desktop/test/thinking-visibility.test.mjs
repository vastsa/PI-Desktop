import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveShowThinking } = await import("../src/lib/thinking-visibility.ts");

test("an explicit showThinking boolean wins over the legacy display mode", () => {
  assert.equal(
    resolveShowThinking({ showThinking: true, thinkingDisplayMode: "compact" }),
    true,
  );
  assert.equal(
    resolveShowThinking({ showThinking: false, thinkingDisplayMode: "detailed" }),
    false,
  );
});

test("legacy compact hides reasoning while detailed and unknown show it", () => {
  assert.equal(resolveShowThinking({ thinkingDisplayMode: "compact" }), false);
  assert.equal(resolveShowThinking({ thinkingDisplayMode: "detailed" }), true);
  assert.equal(resolveShowThinking({ thinkingDisplayMode: "unknown" }), true);
});

test("absent settings and non-boolean showThinking fall back to the legacy field", () => {
  assert.equal(resolveShowThinking(undefined), true);
  assert.equal(resolveShowThinking(null), true);
  assert.equal(resolveShowThinking({}), true);
  assert.equal(resolveShowThinking({ showThinking: undefined }), true);
  assert.equal(resolveShowThinking({ showThinking: null }), true);
  assert.equal(
    resolveShowThinking({ showThinking: null, thinkingDisplayMode: "compact" }),
    false,
  );
  assert.equal(
    resolveShowThinking({ showThinking: null, thinkingDisplayMode: "detailed" }),
    true,
  );
});
