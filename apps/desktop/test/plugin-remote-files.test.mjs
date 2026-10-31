import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const data = await mkdtemp(join(tmpdir(), "pi-remote-plugin-data-"));
process.env.PI_DESKTOP_DATA_DIR = data;
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
test.after(() => rm(data, { recursive: true, force: true }));

const REMOTE = "remote-project:fixture";
const preview = { kind: "text", content: "remote source", size: 13, mtimeMs: 1234 };
async function harness(t, { permissions = ["fs.read"], scope = ["docs/**"], read } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-plugin-"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "test.remote-files",
    name: "Remote fixture", version: "0.0.1", main: "main.js", permissions,
    ...(permissions.includes("fs.read") ? { fs: { read: { root: "workspace", scope } } } : {}) }));
  await writeFile(join(directory, "main.js"), `module.exports = { onPanelInvoke(_channel, input) {
    return pi.fs.readPreview(input.path, { workspacePath: input.workspacePath });
  } };`);
  const requests = []; const audits = [];
  let workspace = REMOTE;
  const runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return { postMessage: message => { if (child.connected) child.send(message); },
        onMessage: handler => child.on("message", handler), onExit: handler => child.on("exit", code => handler(code ?? 0)),
        kill: () => child.kill() };
    },
    getWorkspacePath: () => workspace,
    readRemoteWorkspaceFiles: async request => { requests.push(request); return read ? read(request) : preview; },
    audit: entry => audits.push(entry),
  });
  await runtime.loadFromPath(directory);
  t.after(async () => { await runtime.unload("test.remote-files"); await rm(directory, { recursive: true, force: true }); });
  const invoke = (channel, input) => runtime.invokePanelBridge("test.remote-files", channel, input);
  return { runtime, requests, audits, invoke, directory, select: path => { workspace = path; } };
}

test("real plugin process reads remote bytes with its captured identity and declared scope", { timeout: 60_000 }, async t => {
  const h = await harness(t);
  assert.deepEqual(await h.invoke("fixture.preview", { path: "docs/a.md", workspacePath: REMOTE }), preview);
  assert.deepEqual(h.requests, [{ workspacePath: REMOTE, operation: "preview", ref: "docs/a.md", scope: ["docs/**"] }]);
  assert(h.audits.some(entry => entry.api === "fs.readPreview" && entry.ok));
  await writeFile(join(h.directory, "local.txt"), "local control");
  h.select(h.directory);
  // A changed project can never reinterpret an old remote request as a local path.
  await assert.rejects(h.invoke("fixture.preview", { path: "local.txt", workspacePath: REMOTE }), { code: "WORKSPACE_CHANGED" });
  assert.equal(h.requests.length, 1);
});

test("remote listing preserves its SDK shape through the panel bridge", { timeout: 60_000 }, async t => {
  const entries = [{ name: "a.md", path: "docs/a.md", isDirectory: false, size: 13, mtimeMs: 1234 }];
  const h = await harness(t, { read: async () => ({ kind: "list", entries }) });
  assert.deepEqual(await h.invoke("fs.list", { path: "docs", workspacePath: REMOTE }), entries);
  assert.deepEqual(h.requests[0], { workspacePath: REMOTE, operation: "list", ref: "docs", scope: ["docs/**"] });
});

test("remote reads reject missing permission, invalid replies and transport errors", { timeout: 60_000 }, async t => {
  const noGrant = await harness(t, { permissions: [] });
  await assert.rejects(noGrant.invoke("fs.readPreview", { path: "docs/a.md" }), { code: "PERMISSION_DENIED" });
  assert.equal(noGrant.requests.length, 0);
  const invalid = await harness(t, { read: async () => ({ kind: "text", size: 13, mtimeMs: 1234 }) });
  await assert.rejects(invalid.invoke("fs.readPreview", { path: "docs/a.md" }), { code: "INVALID_RESPONSE" });
  const offline = await harness(t, { read: async () => { throw Object.assign(new Error("fixture disconnected"), { errorCode: "HOST_DISCONNECTED" }); } });
  await assert.rejects(offline.invoke("fs.readPreview", { path: "docs/a.md" }), /disconnected/);
  assert(offline.audits.some(entry => entry.api === "fs.readPreview" && entry.ok === false));
});

test("late remote reads are rejected after project changes or plugin unload", { timeout: 60_000 }, async t => {
  for (const change of ["workspace", "unload"]) {
    const started = Promise.withResolvers(); const finish = Promise.withResolvers();
    const h = await harness(t, { read: () => { started.resolve(); return finish.promise; } });
    const pending = h.invoke("fs.readPreview", { path: "docs/a.md", workspacePath: REMOTE });
    const rejected = assert.rejects(pending, { code: change === "workspace" ? "WORKSPACE_CHANGED" : "PLUGIN_UNLOADED" });
    await started.promise;
    if (change === "workspace") h.select(h.directory);
    else await h.runtime.unload("test.remote-files");
    finish.resolve(preview);
    await rejected;
  }
});

test("local-only plugin actions explicitly reject a remote root", { timeout: 60_000 }, async t => {
  const h = await harness(t, { permissions: ["fs.read", "fs.write"], scope: ["**"] });
  for (const [channel, input] of [["fs.readText", { path: "docs/a.md" }], ["fs.glob", { pattern: "**" }],
    ["fs.writeText", { path: "docs/a.md", content: "must not write locally" }], ["fs.reveal", { path: "docs/a.md" }]]) {
    await assert.rejects(h.invoke(channel, input), { code: "UNSUPPORTED" });
  }
  assert.equal(h.requests.length, 0);
});

test("an expected local workspace cannot be replaced during asynchronous admission", { timeout: 60_000 }, async t => {
  const h = await harness(t);
  const other = await mkdtemp(join(tmpdir(), "pi-other-project-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, "other.txt"), "another project");
  h.select(h.directory);
  const pending = h.invoke("fs.list", { path: "", workspacePath: h.directory });
  h.select(other);
  await assert.rejects(pending, { code: "WORKSPACE_CHANGED" });
});

test("legacy reads retain their admitted local workspace without new SDK options", { timeout: 60_000 }, async t => {
  const h = await harness(t);
  const other = await mkdtemp(join(tmpdir(), "pi-legacy-project-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, "other.txt"), "another project");
  for (const next of [other, REMOTE]) {
    for (const [channel, path] of [["fs.list", ""], ["fs.readPreview", "other.txt"]]) {
      h.select(h.directory);
      const pending = h.invoke(channel, { path });
      h.select(next);
      await assert.rejects(pending, { code: "WORKSPACE_CHANGED" });
    }
  }
  assert.equal(h.requests.length, 0);
});
