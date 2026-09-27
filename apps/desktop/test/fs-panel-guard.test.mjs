import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  imageMimeFor,
  isAttachmentBlobRef,
  isIgnoredName,
  listDir,
  previewFile,
  readOpenableFile,
  readOpenableImage,
  readWorkspaceFile,
  resolveOpenablePath,
  resolveRealOpenablePath,
  resolveWithinRoot,
  MAX_TEXT_BYTES,
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

test("resolveOpenablePath maps attachment blobs onto the attachments extra root", () => {
  const attachments = join(tmpdir(), "attachments");
  const hash = "a".repeat(64);
  assert.equal(isAttachmentBlobRef(`attachments/${hash}`), true);
  assert.equal(isAttachmentBlobRef("attachments/not-a-hash.png"), false);
  assert.equal(
    resolveOpenablePath(`attachments/${hash}`, ROOT, [attachments]),
    join(attachments, hash),
  );
  assert.equal(
    resolveOpenablePath("attachments/notes.png", ROOT, [attachments]),
    join(ROOT, "attachments", "notes.png"),
  );
  assert.equal(resolveOpenablePath(`attachments/${hash}`, ROOT, []), null);
  assert.equal(resolveOpenablePath("/etc/passwd", ROOT, [attachments]), null);
});

test("previewFile classifies text, images, binary, and oversized files", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-fs-preview-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const textPath = join(fixture, "note.md");
  const imagePath = join(fixture, "pixel.png");
  const binaryPath = join(fixture, "blob.bin");
  const largePath = join(fixture, "large.txt");
  await writeFile(textPath, "hello\n");
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await writeFile(binaryPath, Buffer.from([0, 1, 2, 0]));
  await writeFile(largePath, "x".repeat(MAX_TEXT_BYTES + 1));

  const text = previewFile(textPath, "note.md");
  assert.equal(text.kind, "text");
  assert.equal(text.content, "hello\n");

  const image = previewFile(imagePath, "pixel.png");
  assert.equal(image.kind, "image");
  assert.match(String(image.dataUrl), /^data:image\/png;base64,/);

  assert.equal(previewFile(binaryPath, "blob.bin").kind, "binary");
  assert.equal(previewFile(largePath, "large.txt").kind, "tooLarge");
});

test("imageMimeFor prefers a known extension and allowlists declared mime for blobs", () => {
  assert.equal(imageMimeFor("pixel.png"), "image/png");
  assert.equal(imageMimeFor("notes.md", "image/png"), undefined);
  assert.equal(imageMimeFor("a".repeat(64), "image/png"), "image/png");
  assert.equal(imageMimeFor("a".repeat(64), "image/*"), undefined);
  assert.equal(imageMimeFor("a".repeat(64), "text/html"), undefined);
});

test("readOpenableImage serves attachment blobs and rejects escapes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-fs-openable-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = join(fixture, "workspace");
  const attachments = join(fixture, "attachments");
  const outside = join(fixture, "outside");
  await Promise.all([mkdir(workspace), mkdir(attachments), mkdir(outside)]);
  const hash = "b".repeat(64);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(attachments, hash), png);
  await writeFile(join(workspace, "pixel.png"), png);
  await writeFile(join(workspace, "secret.md"), "secret");
  await writeFile(join(outside, "leak.png"), png);

  const extra = [attachments];
  const blob = await readOpenableImage(
    `attachments/${hash}`,
    workspace,
    extra,
    "image/png",
  );
  assert.equal(blob.kind, "image");
  assert.match(String(blob.dataUrl), /^data:image\/png;base64,/);

  const workspaceImage = await readOpenableImage("pixel.png", workspace, extra);
  assert.equal(workspaceImage.kind, "image");

  const missing = await readOpenableImage("/etc/passwd", workspace, extra, "image/png");
  assert.equal(missing.kind, "missing");

  const spoofed = await readOpenableImage("secret.md", workspace, extra, "image/png");
  assert.equal(spoofed.kind, "notImage");

  const outsideAbs = await readOpenableImage(join(outside, "leak.png"), workspace, extra);
  assert.equal(outsideAbs.kind, "missing");

  await assert.rejects(
    readOpenableFile("/etc/passwd", workspace, extra, "image/png"),
    /path outside allowed roots/,
  );

  const link = join(attachments, "c".repeat(64));
  try {
    await symlink(join(outside, "leak.png"), link);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("creating a link is not permitted on this host");
      return;
    }
    throw error;
  }
  const escaped = await resolveRealOpenablePath(
    `attachments/${"c".repeat(64)}`,
    workspace,
    extra,
  );
  assert.equal(escaped, null);
});
