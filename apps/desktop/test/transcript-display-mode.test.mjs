import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  isTranscriptDisplayMode,
  resolveTranscriptDisplayMode,
} = await import("../src/lib/transcript-display-mode.ts");

test("transcript display mode defaults to the released fully-folded layout", () => {
  assert.equal(resolveTranscriptDisplayMode(undefined), "fully-folded");
  assert.equal(resolveTranscriptDisplayMode({}), "fully-folded");
  assert.equal(
    resolveTranscriptDisplayMode({ transcriptDisplayMode: "unknown" }),
    "fully-folded",
  );
  assert.equal(
    resolveTranscriptDisplayMode({ transcriptDisplayMode: "flat" }),
    "flat",
  );
  assert.equal(
    resolveTranscriptDisplayMode({ transcriptDisplayMode: "command-first" }),
    "command-first",
  );
  assert.equal(
    resolveTranscriptDisplayMode({ transcriptDisplayMode: "fully-folded" }),
    "fully-folded",
  );
});

test("the deprecated command-folding preference cannot select a mode", () => {
  assert.equal(
    resolveTranscriptDisplayMode({ keepCommandsExpanded: true }),
    "fully-folded",
  );
  assert.equal(
    resolveTranscriptDisplayMode({ keepCommandsExpanded: false }),
    "fully-folded",
  );
  assert.equal(isTranscriptDisplayMode("flat"), true);
  assert.equal(isTranscriptDisplayMode("command-first"), true);
  assert.equal(isTranscriptDisplayMode("fully-folded"), true);
  assert.equal(isTranscriptDisplayMode("compact"), false);
});
