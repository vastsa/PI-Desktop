import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebaseWorktreeRef } from "../electron/main/worktree-ref.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-ref-"));
  const parent = join(root, "main");
  const worktree = join(root, "worktree");
  await mkdir(join(parent, "docs"), { recursive: true });
  await mkdir(join(worktree, "docs"), { recursive: true });
  await writeFile(join(parent, "docs", "branch-note.md"), "parent\n");
  await writeFile(join(worktree, "docs", "branch-note.md"), "branch\n");
  await writeFile(join(parent, "docs", "parent-only.md"), "parent only\n");
  return { root, parent, worktree };
}

test("a reference without a worktree context is unchanged", async () => {
  assert.equal(
    await rebaseWorktreeRef("/repo/docs/a.md", null),
    "/repo/docs/a.md",
  );
});

test("relative references stay relative", async () => {
  const { root, parent, worktree } = await fixture();
  try {
    assert.equal(
      await rebaseWorktreeRef("docs/branch-note.md", { parent, worktree }),
      "docs/branch-note.md",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reference already inside the worktree is unchanged", async () => {
  const { root, parent, worktree } = await fixture();
  try {
    const ref = join(worktree, "docs", "branch-note.md");
    assert.equal(await rebaseWorktreeRef(ref, { parent, worktree }), ref);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a parent-checkout path resolves to the branch copy in the worktree", async () => {
  const { root, parent, worktree } = await fixture();
  try {
    assert.equal(
      await rebaseWorktreeRef(join(parent, "docs", "branch-note.md"), {
        parent,
        worktree,
      }),
      join(worktree, "docs", "branch-note.md"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a parent-only file keeps its original path when the branch lacks it", async () => {
  const { root, parent, worktree } = await fixture();
  try {
    const ref = join(parent, "docs", "parent-only.md");
    assert.equal(await rebaseWorktreeRef(ref, { parent, worktree }), ref);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sibling directory sharing the parent prefix is not rebased", async () => {
  const { root, parent, worktree } = await fixture();
  try {
    const sibling = join(`${parent}-other`, "docs", "branch-note.md");
    assert.equal(await rebaseWorktreeRef(sibling, { parent, worktree }), sibling);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a worktree nested inside the parent is not rebased onto itself", async () => {
  const { root, worktree } = await fixture();
  try {
    const nested = join(worktree, ".worktrees", "branch");
    await mkdir(join(nested, "docs"), { recursive: true });
    await writeFile(join(nested, "docs", "branch-note.md"), "branch\n");
    const ref = join(nested, "docs", "branch-note.md");
    assert.equal(await rebaseWorktreeRef(ref, { parent: worktree, worktree: nested }), ref);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
