import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".artifacts");
await mkdir(artifacts, { recursive: true });
const scratch = await realpath(await mkdtemp(join(artifacts, "storage-directory-tests-")));
const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("esbuild");
const bundle = join(scratch, "storage.mjs");
await build({ entryPoints: [join(root, "apps/desktop/electron/main/storage/files.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", alias: { "original-fs": "node:fs" } });
const storage = await import(pathToFileURL(bundle).href);

import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url).href);
const { storageLinkTypes } = await import("../electron/main/storage/link-types.ts");

function windowsLinkType(path) {
  return new Promise((resolve, reject) => {
    execFile(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Item -LiteralPath @'
${path}
'@ -Force).LinkType`],
      { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
}

async function createSymlinkOrSkip(t, target, link, type) {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (error.code === "EPERM") { t.skip(`requires the Windows symlink privilege (${type})`); return false; }
    throw error;
  }
}

async function fixture() {
  const directory = await mkdtemp(join(scratch, "case-"));
  const source = { data: join(directory, "data"), browser: join(directory, "browser") };
  await mkdir(source.browser);
  return { directory, source, target: join(directory, "new drive", "PI storage") };
}

test("first-install migration creates a selected destination that does not exist", async () => {
  const { source, target } = await fixture();
  const selected = await storage.validateTarget(target, source, source.browser);
  assert.equal(selected, await realpath(target));
  const next = await storage.migrateFiles({ source, target: selected, anchor: source.browser, id: randomUUID(), progress: () => {}, relocate: async () => { assert.fail("An absent source needs no offline relocation"); } });
  assert.equal((await stat(next.data)).isDirectory(), true);
  assert.equal((await stat(next.browser)).isDirectory(), true);
  await assert.rejects(stat(source.data), { code: "ENOENT" });
});

test("first-install validation handles several missing source ancestors", async () => {
  const value = await fixture();
  value.source.data = join(value.directory, "not initialized", "PI", "data");
  await mkdir(value.target, { recursive: true });
  assert.equal(await storage.validateTarget(value.target, value.source, value.source.browser), await realpath(value.target));
  const next = await storage.migrateFiles({ source: value.source, target: await realpath(value.target), anchor: value.source.browser,
    id: randomUUID(), progress: () => {}, relocate: async () => { assert.fail("No old data exists to relocate"); } });
  assert.equal((await stat(next.data)).isDirectory(), true);
  await assert.rejects(stat(join(value.directory, "not initialized")), { code: "ENOENT" });
});

test("existing conversations migrate to a newly selected destination without changing originals", async () => {
  const { source, target } = await fixture();
  await mkdir(join(source.data, "sessions"), { recursive: true });
  await writeFile(join(source.data, "sessions", "conversation.jsonl"), "existing conversation\n");
  await writeFile(join(source.browser, "Preferences"), '{"fixture":true}');
  const selected = await storage.validateTarget(target, source, source.browser);
  let relocated = false;
  const next = await storage.migrateFiles({ source, target: selected, anchor: source.browser, id: randomUUID(), progress: () => {}, relocate: async (from, to) => {
    assert.equal(from, source.data);
    assert.equal(await readFile(join(to, "sessions", "conversation.jsonl"), "utf8"), "existing conversation\n");
    relocated = true;
  } });
  assert.equal(relocated, true);
  assert.equal(await readFile(join(source.data, "sessions", "conversation.jsonl"), "utf8"), "existing conversation\n");
  assert.equal(await readFile(join(next.browser, "Preferences"), "utf8"), '{"fixture":true}');
});

test("migration excludes only the browser installation lock, not user files named lockfile", async () => {
  const { source, target } = await fixture();
  await mkdir(source.data);
  await mkdir(join(source.browser, "user-files"));
  await writeFile(join(source.browser, "lockfile"), "installation lock");
  await writeFile(join(source.data, "lockfile"), "user data");
  await writeFile(join(source.browser, "user-files/lockfile"), "nested user data");
  const selected = await storage.validateTarget(target, source, source.browser);
  const next = await storage.migrateFiles({ source, target: selected, anchor: source.browser, id: randomUUID(), progress: () => {}, relocate: async () => {} });
  await assert.rejects(stat(join(next.browser, "lockfile")), { code: "ENOENT" });
  assert.equal(await readFile(join(source.browser, "lockfile"), "utf8"), "installation lock");
  assert.equal(await readFile(join(next.data, "lockfile"), "utf8"), "user data");
  assert.equal(await readFile(join(next.browser, "user-files/lockfile"), "utf8"), "nested user data");
});

test("backup cleanup preflights active-root overlap before touching another old root", async () => {
  const { directory, source } = await fixture();
  await mkdir(source.data);
  const oldData = join(directory, "old-data");
  await mkdir(oldData);
  await writeFile(join(oldData, "history.txt"), "retained backup");
  await assert.rejects(storage.removeBackups([{ data: oldData, browser: source.browser }], source, source.browser), /overlaps active storage/);
  assert.equal(await readFile(join(oldData, "history.txt"), "utf8"), "retained backup");
});

test("overlapping destinations are rejected before creating folders", async () => {
  const { source } = await fixture();
  const target = join(source.browser, "new", "destination");
  await assert.rejects(storage.validateTarget(target, source, source.browser), /separate/);
  await assert.rejects(stat(join(source.browser, "new")), { code: "ENOENT" });
});

test("existing unrelated destination files remain untouched", async () => {
  const { source, target } = await fixture();
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "user-file.txt"), "keep me");
  await assert.rejects(storage.validateTarget(target, source, source.browser), /empty/);
  assert.equal(await readFile(join(target, "user-file.txt"), "utf8"), "keep me");
});

test("a missing target below a linked source still cannot overlap active storage", async () => {
  const { directory, source } = await fixture();
  const alias = join(directory, "browser alias");
  await symlink(source.browser, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(storage.validateTarget(join(alias, "new target"), source, source.browser), /separate/);
  await assert.rejects(stat(join(source.browser, "new target")), { code: "ENOENT" });
});

test("a linked destination is rejected instead of writing through the link", async () => {
  const { directory, source, target } = await fixture();
  await mkdir(target, { recursive: true });
  const alias = join(directory, "destination alias");
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(storage.validateTarget(alias, source, source.browser), /symbolic link/);
});

test("a destination that is a file is rejected without changing it", async () => {
  const { directory, source } = await fixture();
  const target = join(directory, "document.txt");
  await writeFile(target, "user document");
  await assert.rejects(storage.validateTarget(target, source, source.browser), /directory/);
  assert.equal(await readFile(target, "utf8"), "user document");
});


test("a junction entry is classified as junction and rebuilt as a junction", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows link classification");
  const { source, target } = await fixture();
  const outside = join(await realpath(await mkdtemp(join(scratch, "outside-"))), "kept");
  await mkdir(outside, { recursive: true });
  await mkdir(source.data, { recursive: true });
  if (!(await createSymlinkOrSkip(t, outside, join(source.data, "linked"), "junction"))) return;
  {
    assert.equal((await storageLinkTypes([join(source.data, "linked")]))[0], "junction");
    const selected = await storage.validateTarget(target, source, source.browser);
    const next = await storage.migrateFiles({ source, target: selected, anchor: source.browser, id: randomUUID(), progress: () => {}, relocate: async () => {} });
    assert.equal(await windowsLinkType(join(next.data, "linked")), "Junction");
  }
});

test("a directory symlink survives migration as a symlink, including a UNC target", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows link classification");
  const { source, target } = await fixture();
  // The #1686 wedge: a dir symlink to a UNC path cannot be rebuilt as a
  // junction, which used to abort the migration and every retry.
  const uncTarget = "\\\\localhost\\c$\\" + basename(scratch);
  await mkdir(source.data, { recursive: true });
  if (!(await createSymlinkOrSkip(t, uncTarget, join(source.data, "netlinked"), "dir"))) return;
  {
    assert.equal((await storageLinkTypes([join(source.data, "netlinked")]))[0], "dir");
    const selected = await storage.validateTarget(target, source, source.browser);
    const next = await storage.migrateFiles({ source, target: selected, anchor: source.browser, id: randomUUID(), progress: () => {}, relocate: async () => {} });
    assert.equal(await windowsLinkType(join(next.data, "netlinked")), "SymbolicLink", "the dir symlink must not become a junction");
  }
});

test("a file symlink pointing at a directory is rebuilt as a directory symlink", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows link classification");
  const { source, target } = await fixture();
  const outside = join(await realpath(await mkdtemp(join(scratch, "outside-"))), "dir-target");
  await mkdir(outside, { recursive: true });
  await mkdir(source.data, { recursive: true });
  if (!(await createSymlinkOrSkip(t, outside, join(source.data, "filelink"), "file"))) return;
  {
    assert.equal((await storageLinkTypes([join(source.data, "filelink")]))[0], "dir", "the target's kind decides dir vs file");
    const selected = await storage.validateTarget(target, source, source.browser);
    const next = await storage.migrateFiles({ source, target: selected, anchor: source.browser, id: randomUUID(), progress: () => {}, relocate: async () => {} });
    assert.equal(await windowsLinkType(join(next.data, "filelink")), "SymbolicLink");
  }
});
