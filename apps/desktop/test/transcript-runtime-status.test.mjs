import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { transcriptRuntimeIndicator } = await import(
  "../src/features/chat/transcript/runtime-status.ts"
);

const running = {
  showStatus: true,
  planningState: "planning",
  hasSpecializedActivity: false,
};

test("a Goal planning fallback uses the ordinary working indicator, like Agent mode", () => {
  assert.equal(
    transcriptRuntimeIndicator({ ...running, mode: "goal" }),
    "working",
  );
  assert.equal(
    transcriptRuntimeIndicator({ ...running, mode: "agent" }),
    "working",
  );
});

test("only Plan mode presents planning while specialized activity keeps precedence", () => {
  assert.equal(
    transcriptRuntimeIndicator({ ...running, mode: "plan" }),
    "planning",
  );
  assert.equal(
    transcriptRuntimeIndicator({ ...running, mode: "goal", hasSpecializedActivity: true }),
    "activity",
  );
  assert.equal(
    transcriptRuntimeIndicator({ ...running, mode: "plan", hasSpecializedActivity: true }),
    "activity",
  );
});

test("non-running turns do not render a runtime status indicator", () => {
  assert.equal(
    transcriptRuntimeIndicator({ ...running, showStatus: false, mode: "plan" }),
    undefined,
  );
});
