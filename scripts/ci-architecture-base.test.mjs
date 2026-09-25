import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("PR architecture budgets use the checked-out integration base, not a stale webhook SHA", () => {
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /ARCHITECTURE_BASE: \$\{\{ github\.event_name == 'pull_request' && 'HEAD\^1' \|\| github\.event\.before \|\| 'HEAD\^' \}\}/);
  assert.doesNotMatch(workflow, /ARCHITECTURE_BASE:.*github\.event\.pull_request\.base\.sha/);
});
