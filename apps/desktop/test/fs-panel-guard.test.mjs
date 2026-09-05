import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  isIgnoredName,
  listDir,
  readWorkspaceFile,
  resolveOpenablePath,
  resolveWithinRoot,
} from "../electron/main/fs-panel.ts";

const ROOT = resolve("virtual-workspace");

test("resolves relative paths inside the workspace root", () => {
  assert.equal(resolveWithinRoot(ROOT, ""), ROOT);
  assert.equal(resolveWithinRoot(ROOT, "src/app.ts"), join(ROOT, "src", "app.ts"));
  assert.equal(
    resolveWithinRoot(ROOT, "a/./b/../c.txt"),
    join(ROOT, "a", "c.txt"),
  );
});

test("rejects traversal and absolute escapes", () => {
  assert.equal(resolveWithinRoot(ROOT, ".."), null);
  assert.equal(resolveWithinRoot(ROOT, "../sibling"), null);
  assert.equal(resolveWithinRoot(ROOT, "src/../../etc/passwd"), null);
  // Absolute inputs are treated as root-relative, not trusted as-is.
  assert.equal(
    resolveWithinRoot(ROOT, "/etc/passwd"),
    join(ROOT, "etc", "passwd"),
  );
  // A sibling directory sharing the root as a string prefix must not pass.
  assert.equal(resolveWithinRoot(ROOT, "../project-evil/x"), null);
  assert.equal(resolveWithinRoot("", "anything"), null);
});

test("default ignore list hides vcs and dependency directories", () => {
  for (const name of [".git", "node_modules", "target", "__pycache__"]) {
    assert.equal(isIgnoredName(name), true, name);
  }
  assert.equal(isIgnoredName("src"), false);
  assert.equal(isIgnoredName("gitignore"), false);
});

test("work panel never follows a workspace link outside the real root", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-fs-panel-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "workspace");
  const outside = join(fixture, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(outside, "secret.md"), "outside");
  const link = join(root, "linked");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("creating a link is not permitted on this host");
      return;
    }
    throw error;
  }

  const entries = await listDir(root, "");
  assert.equal(entries.some((entry) => entry.name === "linked"), false);
  await assert.rejects(
    readWorkspaceFile(root, "linked/secret.md"),
    /path escapes workspace root/,
  );
});

test("resolveOpenablePath allows workspace-relative and contained absolute paths", () => {
  const scratch = join(tmpdir(), "pi-scratch-root");
  assert.equal(
    resolveOpenablePath("src/a.ts", ROOT, [scratch]),
    join(ROOT, "src", "a.ts"),
  );
  assert.equal(
    resolveOpenablePath(join(ROOT, "src", "a.ts"), ROOT, [scratch]),
    join(ROOT, "src", "a.ts"),
  );
  assert.equal(
    resolveOpenablePath(join(scratch, "sess", "pasted", "x.png"), ROOT, [scratch]),
    join(scratch, "sess", "pasted", "x.png"),
  );
});

test("resolveOpenablePath rejects escapes and relative paths without a workspace", () => {
  const scratch = join(tmpdir(), "pi-scratch-root");
  assert.equal(resolveOpenablePath("../outside.ts", ROOT, [scratch]), null);
  assert.equal(resolveOpenablePath("/etc/passwd", ROOT, [scratch]), null);
  assert.equal(resolveOpenablePath("src/a.ts", null, [scratch]), null);
  assert.equal(resolveOpenablePath("~/secret.ts", ROOT, [scratch]), null);
});
