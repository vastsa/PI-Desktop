import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/ts-import-hooks.mjs";
import { pluginWorkspaceContains } from "../electron/main/plugin-workspace-contains.ts";

test("plugin workspace containment unifies Windows separator spellings", () => {
  // The plugin folder arrives from a native dialog, the workspace from the
  // host; before the fix the probe built a "/"-suffixed prefix and never
  // matched a backslashed plugin path on Windows.
  assert.equal(pluginWorkspaceContains("C:/dev/repo", "C:\\dev\\repo\\plugins\\my-plugin"), true);
  assert.equal(pluginWorkspaceContains("C:\\dev\\repo", "C:\\dev\\repo\\plugins\\my-plugin"), true);
  assert.equal(pluginWorkspaceContains("C:/dev/repo", "C:/dev/repo/plugins/my-plugin"), true);
  // The host's `//?/X:/…` long-path spelling normalizes away.
  assert.equal(pluginWorkspaceContains("//?/C:/dev/repo", "C:\\dev\\repo\\plugins\\p"), true);
  // The plugin loaded from the workspace root itself counts.
  assert.equal(pluginWorkspaceContains("C:/dev/repo", "C:\\dev\\repo"), true);
  // Case folds everywhere but Linux, like the worktree ref folding.
  const caseFolds = process.platform !== "linux";
  assert.equal(
    pluginWorkspaceContains("C:/Dev/Repo", "c:\\dev\\REPO\\plugins\\p") === caseFolds,
    true,
  );
});

test("plugin workspace containment keeps the prefix boundary", () => {
  // A sibling that merely shares a textual prefix must not count.
  assert.equal(pluginWorkspaceContains("C:/dev/repo", "C:/dev/repo-x/plugin"), false);
  assert.equal(pluginWorkspaceContains("/home/dev/repo", "/home/dev/repo-x/plugin"), false);
  assert.equal(pluginWorkspaceContains("/home/dev/repo", "/home/dev/repo/plugin"), true);
  assert.equal(pluginWorkspaceContains("/home/dev/repo", "/elsewhere/plugin"), false);
  // Trailing separators on either side do not break the comparison.
  assert.equal(pluginWorkspaceContains("/home/dev/repo/", "/home/dev/repo/plugin"), true);
});

test("a filesystem-root workspace still contains its plugin folders", () => {
  // Normalizing a bare root away would make it contain nothing at all, while
  // the prefix check it replaced matched every absolute path.
  assert.equal(pluginWorkspaceContains("/", "/tmp/plugins/example"), true);
  assert.equal(pluginWorkspaceContains("/", "/"), true);
  assert.equal(pluginWorkspaceContains("///", "/tmp/plugins/example"), true);
  assert.equal(pluginWorkspaceContains("/", "tmp/plugins/example"), false);

  // Drive roots keep their shape through the fold, so containment is the same
  // test as for any other folder.
  assert.equal(pluginWorkspaceContains("C:\\", "C:\\dev\\repo\\plugins\\p"), true);
  assert.equal(pluginWorkspaceContains("C:/", "C:/dev/repo/plugins/p"), true);
  assert.equal(pluginWorkspaceContains("C:/", "C:"), true);
  assert.equal(pluginWorkspaceContains("C:/", "D:/dev/repo/plugins/p"), false);
  // The verbatim drive root folds to the same root.
  assert.equal(pluginWorkspaceContains("//?/C:/", "C:\\dev\\repo\\plugins\\p"), true);
  // A root still respects the sibling boundary: nothing outranks it, but a
  // relative path is not inside it.
  assert.equal(pluginWorkspaceContains("C:/", "C:/dev"), true);
});
