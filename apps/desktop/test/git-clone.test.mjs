import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneGitRepository,
  parseGitCloneUrl,
} from "../electron/main/git-clone.ts";

test("parseGitCloneUrl accepts https, ssh, and scp remotes", () => {
  assert.deepEqual(parseGitCloneUrl("https://github.com/org/pi-desktop.git"), {
    url: "https://github.com/org/pi-desktop.git",
    name: "pi-desktop",
  });
  assert.deepEqual(parseGitCloneUrl("git@github.com:org/plugins.git"), {
    url: "git@github.com:org/plugins.git",
    name: "plugins",
  });
  assert.deepEqual(parseGitCloneUrl("ssh://git@github.com/org/repo"), {
    url: "ssh://git@github.com/org/repo",
    name: "repo",
  });
});

test("parseGitCloneUrl rejects unsafe or incomplete remotes", () => {
  assert.equal(parseGitCloneUrl(""), null);
  assert.equal(parseGitCloneUrl("not a url"), null);
  assert.equal(parseGitCloneUrl("file:///tmp/repo.git"), null);
  assert.equal(parseGitCloneUrl("https://user:pass@github.com/org/repo.git"), null);
  assert.equal(parseGitCloneUrl("git@github.com:org/."), null);
});

test("cloneGitRepository refuses an existing destination and path escape", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clone-"));
  try {
    mkdirSync(join(root, "taken"));
    await assert.rejects(
      () =>
        cloneGitRepository({
          url: "https://github.com/org/taken.git",
          parentPath: root,
        }),
      /already exists/,
    );
    await assert.rejects(
      () =>
        cloneGitRepository({
          url: "https://github.com/org/ok.git",
          parentPath: root,
          name: "..",
        }),
      /git repository URL/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneGitRepository runs git clone -- url dest", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clone-"));
  try {
    let captured;
    const dest = await cloneGitRepository({
      url: "https://github.com/org/demo.git",
      parentPath: root,
      run: async (_cwd, args) => {
        captured = { args };
        mkdirSync(join(root, "demo"));
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(dest, join(root, "demo"));
    assert.deepEqual(captured.args, [
      "clone",
      "--",
      "https://github.com/org/demo.git",
      join(root, "demo"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
