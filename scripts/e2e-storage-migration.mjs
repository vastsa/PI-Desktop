#!/usr/bin/env node
/** Real host RPC → cold Node copy → offline Rust relocation → reopened host.
 * Uses only temporary profiles, local plugin fixtures, and no inference/network.
 * Build host-core first and set PI_DESKTOP_HOST_BIN when reusing a shared target.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolveHostBinary();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-storage-migration-e2e-")));
const source = { data: join(scratch, "old-data"), browser: join(scratch, "old-browser") };
const target = join(scratch, "destination");
const pluginSource = join(scratch, "plugin-source");
const sourceHost = new Host(binary, source.data);
let destinationHost;
const storageBundle = join(scratch, "storage.mjs");

async function put(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
}
async function fingerprint(directory) {
  const entries = [];
  async function walk(path, suffix = "") {
    const info = await lstat(path);
    if (info.isSymbolicLink()) entries.push([suffix, "link", await readlink(path)]);
    else if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name), join(suffix, name));
    else entries.push([suffix, createHash("sha256").update(await readFile(path)).digest("hex"), info.mode & 0o777]);
  }
  await walk(directory);
  return entries;
}
async function closeGracefully(host) {
  host.child.stdin.end();
  const result = await Promise.race([
    host.exitPromise,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("host EOF timeout")), 10_000); timer.unref(); }),
  ]);
  assert.equal(result.code, 0, host.stderr);
  await host.stop();
}

try {
  await Promise.all([mkdir(source.browser), mkdir(target), mkdir(pluginSource)]);
  await build({ entryPoints: [join(root, "apps/desktop/electron/main/storage/files.ts")],
    outfile: storageBundle, bundle: true, platform: "node", format: "esm" });
  const storage = await import(pathToFileURL(storageBundle).href);
  await sourceHost.start();
  const { session } = await sourceHost.call("session.create", { title: "Migration survives restart" });
  const { path: sessionScratch } = await sourceHost.call("session.getScratchPath", { sessionId: session.id });
  const pasted = join(sessionScratch, "pasted", "input.txt");
  await put(pasted, "preserved user document");
  const insideProject = join(source.data, "projects", "local-project");
  const externalProject = join(scratch, "external-project");
  await Promise.all([mkdir(insideProject, { recursive: true }), mkdir(externalProject)]);
  await sourceHost.call("workspace.set", { path: insideProject });
  await sourceHost.call("project.memory.set", { path: insideProject, content: "Durable project memory" });
  const { session: projectSession } = await sourceHost.call("session.create", { title: "Project binding", projectPath: insideProject });
  await sourceHost.call("workspace.set", { path: externalProject });
  await sourceHost.call("session.appendMessage", { sessionId: session.id, message: {
    id: randomUUID(), role: "user", content: `Historical path: ${pasted}`, createdAt: new Date().toISOString(),
    attachments: [{ kind: "file", name: "input.txt", ref: pasted, mimeType: "text/plain" }],
  } });
  await sourceHost.call("session.queuePush", { id: randomUUID(), sessionId: session.id, principal: "user",
    inputHash: "fixture-queued-input", content: "Queued request", permissionMode: "ask",
    attachments: [{ kind: "file", name: "input.txt", ref: pasted }] });
  await sourceHost.call("settings.set", { language: "zh-CN", theme: "light", enterToSend: false });
  await sourceHost.call("secrets.set", { secretRef: "secret:e2e-storage-fixture", value: "temporary-fixture-credential" });
  await put(join(pluginSource, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "storage-e2e", name: "Storage fixture", version: "1.0.0", main: "main.js", permissions: [] }));
  await put(join(pluginSource, "main.js"), "module.exports = {};");
  await sourceHost.call("plugins.installFromPath", { path: pluginSource, enable: false });
  await closeGracefully(sourceHost);
  await put(join(source.data, "plugins/data/storage-e2e/state.json"), '{"keep":"private plugin state"}');
  await put(join(source.data, "cache/disposable.bin"), "disposable host cache");
  await put(join(source.data, "attachments/blob"), "durable attachment bytes");
  await put(join(source.data, "logs/keep.log"), "historical diagnostic log");
  await put(join(source.browser, "Local Storage/leveldb/000003.log"), "persisted renderer preferences fixture");
  await put(join(source.browser, "Partitions/plugin-fixture/Cookies"), "persisted cookie fixture");
  await put(join(source.browser, "Cache/disposable"), "disposable browser cache");
  if (process.platform !== "win32") {
    await symlink(pasted, join(sessionScratch, "absolute-link"));
    await chmod(join(source.data, "secrets/.machine-key"), 0o600);
  }
  const beforeData = await fingerprint(source.data);
  const beforeBrowser = await fingerprint(source.browser);
  const stages = [];
  let relocations = 0;
  const next = await storage.migrateFiles({ source, target, anchor: source.browser, id: randomUUID(),
    progress: (value) => { stages.push(value.stage); },
    relocate: async (oldRoot, newRoot) => {
      relocations++;
      assert(stages.includes("verifying"), "copy verification precedes Rust database relocation");
      await promisify(execFile)(binary, ["--relocate-data", oldRoot, newRoot], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    },
  });
  assert.equal(relocations, 1);
  for (const stage of ["scanning", "copying", "verifying", "relocating", "complete"]) assert(stages.includes(stage), stage);
  assert.deepEqual(await fingerprint(source.data), beforeData, "old data profile stays byte-identical");
  assert.deepEqual(await fingerprint(source.browser), beforeBrowser, "old browser profile stays byte-identical");
  const movedPasted = join(next.data, "scratch", session.id, "pasted/input.txt");
  assert.equal(await readFile(movedPasted, "utf8"), "preserved user document");
  if (process.platform !== "win32") {
    assert.equal(await readlink(join(next.data, "scratch", session.id, "absolute-link")), movedPasted);
    assert.equal((await lstat(join(next.data, "secrets/.machine-key"))).mode & 0o777, 0o600);
  }
  destinationHost = new Host(binary, next.data);
  await destinationHost.start();
  const { session: restored } = await destinationHost.call("session.get", { id: session.id });
  assert.equal(restored.messages[0].attachments[0].ref, movedPasted);
  assert.equal(restored.messages[0].content, `Historical path: ${pasted}`);
  const { entries } = await destinationHost.call("session.queueList", { sessionId: session.id });
  assert.equal(entries[0].attachments[0].ref, movedPasted);
  const { session: rebound } = await destinationHost.call("session.get", { id: projectSession.id });
  assert.equal(rebound.projectPath, join(next.data, "projects/local-project"));
  const { memory } = await destinationHost.call("project.memory.get", { path: join(next.data, "projects/local-project") });
  assert.equal(memory.content, "Durable project memory");
  const settings = await destinationHost.call("settings.get");
  assert.equal(settings.language, "zh-CN"); assert.equal(settings.theme, "light"); assert.equal(settings.enterToSend, false);
  const { value: credential } = await destinationHost.call("secrets.getForRuntime", { secretRef: "secret:e2e-storage-fixture" });
  assert.equal(credential, "temporary-fixture-credential");
  const { plugins } = await destinationHost.call("plugins.list");
  assert.equal(plugins.find((plugin) => plugin.id === "storage-e2e").path, join(next.data, "plugins/installed/storage-e2e"));
  await closeGracefully(destinationHost);
  const critical = ["pi.sqlite", "sessions", "secrets", "scratch", "attachments", "plugins/data", "logs"];
  const preserved = await Promise.all(critical.map((name) => fingerprint(join(next.data, name))));
  await storage.clearCaches(next);
  assert.deepEqual(await Promise.all(critical.map((name) => fingerprint(join(next.data, name)))), preserved);
  await assert.rejects(readFile(join(next.data, "cache/disposable.bin")), { code: "ENOENT" });
  await assert.rejects(readFile(join(next.browser, "Cache/disposable")), { code: "ENOENT" });
  assert.equal(await readFile(join(next.browser, "Local Storage/leveldb/000003.log"), "utf8"), "persisted renderer preferences fixture");
  assert.equal(await readFile(join(next.browser, "Partitions/plugin-fixture/Cookies"), "utf8"), "persisted cookie fixture");
  console.log("PASS real storage migration: verified Node copy, offline Rust CLI, reopened session/project/plugin/settings/credential/queue, visible stages, source backups, cache preservation");
} finally {
  await sourceHost.stop();
  await destinationHost?.stop();
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
