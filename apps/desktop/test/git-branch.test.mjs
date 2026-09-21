import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { withGitBranch } = await import("../electron/main/git-branch.ts");

test("reads branches from standard repositories and git worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-branch-"));
  try {
    const standard = join(root, "standard");
    await mkdir(join(standard, ".git"), { recursive: true });
    await writeFile(join(standard, ".git", "HEAD"), "ref: refs/heads/feature/standard\n");
    assert.deepEqual(
      await withGitBranch({ path: standard, name: "standard" }),
      { path: standard, name: "standard", branch: "feature/standard" },
    );

    const worktree = join(root, "worktree");
    const metadata = join(root, "metadata");
    await mkdir(worktree);
    await mkdir(metadata);
    await writeFile(join(worktree, ".git"), "gitdir: ../metadata\n");
    await writeFile(join(metadata, "HEAD"), "ref: refs/heads/fix/worktree\n");
    assert.deepEqual(
      await withGitBranch({ path: worktree, name: "worktree" }),
      { path: worktree, name: "worktree", branch: "fix/worktree" },
    );

    await writeFile(join(metadata, "HEAD"), "0123456789abcdef\n");
    assert.equal((await withGitBranch({ path: worktree }))?.branch, "detached");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps non-git workspaces usable without a branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-no-git-branch-"));
  try {
    assert.deepEqual(
      await withGitBranch({ path: root, name: "folder" }),
      { path: root, name: "folder", branch: undefined },
    );
    assert.equal(await withGitBranch(null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
