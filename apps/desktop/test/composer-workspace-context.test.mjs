import { readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const composerSource = await readComposerSource();
const globalStyles = await loadStyles();

test("composer omits the workspace context rail", () => {
  assert.match(composerSource, /composer-shell/);
  assert.doesNotMatch(composerSource, /composer-chips/);
  assert.doesNotMatch(composerSource, /chat\.(?:workspaceContext|localWorkspace|local|branch)/);
  assert.doesNotMatch(composerSource, /Icon(?:Computer|GitBranch)/);
});

test("workspace context rail styles are removed", () => {
  assert.doesNotMatch(globalStyles, /\.composer-chips\b/);
  assert.doesNotMatch(globalStyles, /\.chip-sep\b/);
  assert.doesNotMatch(globalStyles, /\.chip-label\b/);
});
