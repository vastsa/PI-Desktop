import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  readOpenableImage,
  resolveOpenablePath,
  resolveRealOpenablePath,
} from "./workspace-files.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const temps: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Creating links is not always permitted; callers skip then. */
async function linkOrSkip(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
    throw error;
  }
}

it("opens a canonicalized path under a root that is still an alias", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const base = await tempDir("pi-ws-alias-");
  const realRoot = join(base, "real");
  const aliasRoot = join(base, "alias");
  await mkdir(realRoot);
  await writeFile(join(realRoot, "generated.png"), PNG);
  await writeFile(join(realRoot, "notes.txt"), "hello");
  if (!(await linkOrSkip(realRoot, aliasRoot))) {
    ctx.skip();
    return;
  }

  // Writers canonicalize before recording the path (`image-generation-service`
  // realpaths its output dir), so the transcript can carry `/private/var/...`
  // while the allowed root is still spelled `/var/...`.
  const canonicalFile = await realpath(join(realRoot, "generated.png"));
  expect(resolveOpenablePath(canonicalFile, aliasRoot, [])).toBeNull();
  expect(await resolveRealOpenablePath(canonicalFile, aliasRoot, [])).toBe(canonicalFile);
  expect(await resolveRealOpenablePath(canonicalFile, null, [aliasRoot])).toBe(canonicalFile);
  expect(await resolveRealOpenablePath(canonicalFile, aliasRoot, [realRoot])).toBe(
    canonicalFile,
  );

  // Absolute paths and attachment blobs keep working through the alias too.
  const canonicalAlias = await realpath(join(aliasRoot, "notes.txt"));
  expect(await resolveRealOpenablePath(canonicalAlias, aliasRoot, [])).toBe(
    canonicalAlias,
  );
});

it("stores a generated image reference that the reader can open", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const base = await tempDir("pi-ws-scratch-");
  const dataDir = join(base, "data");
  const scratch = join(dataDir, "scratch");
  const workspace = join(base, "workspace");
  await mkdir(scratch, { recursive: true });
  await mkdir(workspace);
  await writeFile(join(scratch, "generated-1.png"), PNG);
  if (!(await linkOrSkip(dataDir, join(base, "data-alias")))) {
    ctx.skip();
    return;
  }

  // Exactly what `image-generation-service` writes into the transcript.
  const stored = await realpath(join(scratch, "generated-1.png"));
  const result = await readOpenableImage(stored, workspace, [scratch]);
  expect(result).toMatchObject({ kind: "image", size: PNG.length });
  expect(String((result as { dataUrl?: string }).dataUrl)).toMatch(
    /^data:image\/png;base64,/,
  );

  // The alias spelling was always accepted and must keep working.
  const alias = await readOpenableImage(join(scratch, "generated-1.png"), workspace, [
    scratch,
  ]);
  expect(alias.kind).toBe("image");
});

it("still refuses a link inside an allowed root that points outside it", async (ctx) => {
  if (process.platform === "win32") ctx.skip();
  const base = await tempDir("pi-ws-escape-");
  const root = join(base, "root");
  const outside = join(base, "outside");
  const other = join(base, "other");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(other);
  await writeFile(join(outside, "leak.png"), PNG);
  const link = join(root, "leak.png");
  if (!(await linkOrSkip(join(outside, "leak.png"), link))) {
    ctx.skip();
    return;
  }

  const canonicalOutside = await realpath(join(outside, "leak.png"));
  expect(await resolveRealOpenablePath(link, root, [])).toBeNull();
  expect(await resolveRealOpenablePath(canonicalOutside, root, [])).toBeNull();
  expect(await resolveRealOpenablePath(link, other, [root])).toBeNull();
  expect(await resolveRealOpenablePath(canonicalOutside, other, [root])).toBeNull();

  const result = await readOpenableImage(link, root, [], "image/png");
  expect(result).toMatchObject({
    kind: "missing",
    errorCode: "PATH_OUTSIDE_ALLOWED_ROOT",
  });
});

it("keeps relative, absolute and workspace-boundary behavior", async () => {
  const base = await tempDir("pi-ws-bounds-");
  const root = join(base, "workspace");
  const scratch = join(base, "scratch");
  const attachments = join(base, "attachments");
  const hash = "a".repeat(64);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(scratch);
  await mkdir(attachments);
  await writeFile(join(root, "src", "a.ts"), "x");
  await writeFile(join(scratch, "pasted.png"), PNG);
  await writeFile(join(attachments, hash), PNG);
  await writeFile(join(base, "outside.png"), PNG);

  const workspaceFile = join(root, "src", "a.ts");
  expect(await resolveRealOpenablePath("src/a.ts", root, [scratch])).toBe(
    await realpath(workspaceFile),
  );
  expect(await resolveRealOpenablePath(workspaceFile, root, [scratch])).toBe(
    await realpath(workspaceFile),
  );
  expect(await resolveRealOpenablePath(join(scratch, "pasted.png"), root, [scratch])).toBe(
    await realpath(join(scratch, "pasted.png")),
  );
  expect(await resolveRealOpenablePath(`attachments/${hash}`, root, [attachments])).toBe(
    await realpath(join(attachments, hash)),
  );

  expect(await resolveRealOpenablePath("../outside.png", root, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath("src/a.ts", null, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath("~/secret.png", root, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath(join(base, "outside.png"), root, [scratch])).toBeNull();
  expect(await resolveRealOpenablePath(`attachments/notes.png`, root, [attachments])).toBeNull();
  expect(await resolveRealOpenablePath(`attachments/${hash}`, root, [])).toBeNull();
  expect(await resolveRealOpenablePath("", root, [scratch])).toBeNull();
  if (process.platform !== "win32") {
    expect(await resolveRealOpenablePath("/etc/passwd", root, [scratch])).toBeNull();
  }
});
