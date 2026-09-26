import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openableMp4Path } from "../electron/main/open-attachment-video.ts";

test("an extensionless stored MP4 gets an OS-openable name without copying bytes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mp4-open-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const attachments = join(dataDir, "attachments");
  await mkdir(attachments);
  const hash = "a".repeat(64);
  const stored = join(attachments, hash);
  await writeFile(stored, Buffer.alloc(512 * 1024 + 1));
  const storedReal = await realpath(stored);

  const alias = await openableMp4Path(dataDir, storedReal, "video/mp4");
  assert.equal(alias, join(dataDir, "openable-attachments", `${hash}.mp4`));
  assert.equal(await realpath(alias), storedReal);
  assert.equal(await readlink(alias), storedReal);
  assert.equal((await stat(alias)).size, 512 * 1024 + 1);
  assert.equal(await openableMp4Path(dataDir, storedReal, "video/mp4"), alias);
});

test("only a typed content-addressed MP4 is given an alias", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mp4-open-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = join(dataDir, "clip.mp4");
  await writeFile(file, "video");
  const workspace = join(dataDir, "workspace");
  await mkdir(workspace);
  const hashNamedProjectFile = join(workspace, "b".repeat(64));
  await writeFile(hashNamedProjectFile, "project file");

  assert.equal(await openableMp4Path(dataDir, file, "video/mp4"), file);
  assert.equal(await openableMp4Path(dataDir, file, "text/plain"), file);
  assert.equal(await openableMp4Path(dataDir, hashNamedProjectFile, "video/mp4"), hashNamedProjectFile);
});

test("an occupied alias cannot redirect the OS handoff", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mp4-open-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const attachments = join(dataDir, "attachments");
  const aliases = join(dataDir, "openable-attachments");
  await Promise.all([mkdir(attachments), mkdir(aliases)]);
  const hash = "c".repeat(64);
  const stored = join(attachments, hash);
  await writeFile(stored, "video");
  await writeFile(join(aliases, `${hash}.mp4`), "different file");

  await assert.rejects(
    openableMp4Path(dataDir, await realpath(stored), "video/mp4"),
    /already occupied/,
  );
});
