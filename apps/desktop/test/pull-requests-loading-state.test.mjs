import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(
  new URL("../src/pages/PullRequestsPage.tsx", import.meta.url),
  "utf8",
);

test("pull request loading is distinct from the empty result state", () => {
  const noWorkspaceBranch = page.indexOf("!workspace?.path ? (");
  const loadingBranch = page.indexOf("pageLoading && visiblePulls.length === 0 ? (");
  const emptyBranch = page.indexOf("filtered.length === 0 ? (");

  assert.ok(noWorkspaceBranch >= 0);
  assert.ok(loadingBranch > noWorkspaceBranch);
  assert.ok(emptyBranch > loadingBranch);
  assert.match(page.slice(loadingBranch, emptyBranch), /role="status"/);
  assert.match(page.slice(loadingBranch, emptyBranch), /aria-busy="true"/);
  assert.match(page.slice(loadingBranch, emptyBranch), /t\("app\.loadingView"\)/);
});

test("pull request refresh ignores results from an old request or workspace", () => {
  assert.match(page, /const request = \+\+requestSequence\.current/);
  assert.match(page, /if \(request !== requestSequence\.current\) return;/);
  assert.match(page, /const workspaceDataCurrent = loadedWorkspacePath === workspacePath/);
  assert.match(page, /return \(\) => \{\s*requestSequence\.current \+= 1;/);
});
