#!/usr/bin/env node
/** Settings -> real IPC -> cold bootstrap -> reopened Host; no providers or user profiles. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = resolve(repositoryRoot());
const artifactRoot = process.env.PI_STORAGE_E2E_ARTIFACTS ?? join(root, ".artifacts");
await mkdir(artifactRoot, { recursive: true });
const artifacts = await realpath(await mkdtemp(join(artifactRoot, "storage-directory-e2e-")));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const hostBinary = resolveHostBinary();
const electronBinary = resolveElectronBinary(root).electronBinary;
const sourceRoot = process.env.PI_STORAGE_E2E_SOURCE_ROOT ?? artifacts;
await mkdir(sourceRoot, { recursive: true });

await build({ entryPoints: [join(root, "scripts/e2e/storage-directory.jsx")],
  outfile: join(artifacts, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
    "@pi-desktop/shared/changelog-loader": join(root, "packages/shared/src/changelog-loader.ts"),
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    "@pi-desktop/voice-runtime/live": join(root, "packages/voice-runtime/src/live/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    i18next: join(root, "apps/desktop/node_modules/i18next"),
    "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
  nodePaths: [join(root, "apps/desktop/node_modules")],
});
await build({ entryPoints: [join(root, "apps/desktop/electron/preload/index.ts")],
  outfile: join(artifacts, "preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"] });
const builtHtml = await readFile(join(root, "apps/desktop/out/renderer/index.html"), "utf8");
const cssPaths = [...builtHtml.matchAll(/href="([^" ]+\.css)"/g)].map(match => match[1]);
assert(cssPaths.length, "Build Desktop before running storage directory E2E");
const css = (await Promise.all(cssPaths.map(path => readFile(join(root, "apps/desktop/out/renderer", path), "utf8")))).join("\n");
await writeFile(join(artifacts, "index.html"), '<!doctype html><html data-platform="win32" data-theme="dark"><head><meta charset="utf-8"><style>' + css + '</style></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');

const main = join(artifacts, "main.mjs");
await build({ entryPoints: [join(root, "scripts/e2e/storage-directory-main.mjs")], outfile: main,
  bundle: true, platform: "node", format: "esm", external: ["electron", "original-fs"],
  alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"), "@pi-desktop/shared": join(root, "packages/shared/src/protocol.ts") },
  plugins: [{ name: "fixture-host-location", setup(builder) {
    builder.onResolve({ filter: /host-process$/ }, () => ({ path: "host-location", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function resolveHostBinary() { return process.env.PI_DESKTOP_HOST_BIN; }" }));
  } }],
});

async function launch(config, mode) {
  const result = join(config.directory, mode + ".json");
  const env = { ...process.env, PI_DESKTOP_HOST_BIN: hostBinary, PI_STORAGE_E2E_CONFIG: JSON.stringify({ ...config, mode, result, artifacts }) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [main], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill(), 60000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); }
  finally { clearTimeout(timer); await writeFile(join(config.directory, mode + ".log"), output); }
  assert.equal(code, 0, output);
  const value = JSON.parse(await readFile(result, "utf8"));
  assert.deepEqual(value.errors, [], JSON.stringify(value));
  return value;
}
async function stopHost(host) {
  host.child.stdin.end();
  const timer = setTimeout(() => host.child?.kill(), 15000);
  try { const exited = await host.exitPromise; assert.equal(exited.code, 0, host.stderr); }
  finally { clearTimeout(timer); await host.stop(); }
}

const checks = [];
for (const name of ["first-install", "existing-profile"]) {
  const directory = await mkdtemp(join(artifacts, name + "-"));
  const source = await mkdtemp(join(sourceRoot, name + "-source-"));
  const config = { directory, anchor: join(source, "browser"), data: join(source, "not initialized", "PI data"), target: join(directory, "new volume", "PI storage") };
  await mkdir(config.anchor);
  let sessionId;
  const host = new Host(hostBinary, config.data);
  try {
    if (name === "existing-profile") {
      await host.start();
      const { session } = await host.call("session.create", { title: "Conversation survives storage migration" });
      sessionId = session.id;
      await host.call("settings.set", { language: "zh-CN", theme: "light", enterToSend: false });
      const project = join(config.data, "projects", "saved project");
      await mkdir(project, { recursive: true });
      await host.call("workspace.set", { path: project });
      await host.call("project.memory.set", { path: project, content: "Keep project instructions after moving drives" });
      const attachment = join(config.data, "attachments", "迁移 attachment.txt");
      await mkdir(dirname(attachment), { recursive: true }); await writeFile(attachment, "retained attachment");
      await host.call("session.appendMessage", { sessionId, message: { id: "storage-fixture-message", role: "user", content: "Keep my conversation", createdAt: new Date().toISOString(), attachments: [{ kind: "file", name: "migration.txt", ref: attachment, mimeType: "text/plain" }] } });
      await stopHost(host);
      const resources = join(config.data, "scratch", "packaged-app", "resources");
      await mkdir(resources, { recursive: true });
      await writeFile(join(resources, "app.asar"), "opaque archive fixture");
      await symlink(join(source, "missing dependency"), join(resources, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    }
    assert.equal((await launch(config, "choose")).scheduled, true);
    const migrated = await launch(config, "maintenance");
    assert.equal(migrated.relaunched, true);
    const pointer = JSON.parse(await readFile(join(config.anchor, "storage-location.json"), "utf8"));
    assert.equal(pointer.roots.data, join(config.target, "data"));
    assert.equal(pointer.pending, undefined);
    if (sessionId) {
      const resources = join(pointer.roots.data, "scratch", "packaged-app", "resources");
      assert.equal(await readFile(join(resources, "app.asar"), "utf8"), "opaque archive fixture");
      assert.equal(await readlink(join(resources, "node_modules")), join(source, "missing dependency"));
    }
    const reopened = await launch(config, "inspect");
    assert.equal(reopened.sessionData, join(config.target, "browser"));
    assert.equal(reopened.browserState, "browser state survives restart");
    const nextHost = new Host(hostBinary, pointer.roots.data);
    try {
      await nextHost.start();
      if (sessionId) {
        const { session } = await nextHost.call("session.get", { id: sessionId });
        assert.equal(session.messages[0].content, "Keep my conversation");
        assert.equal(await readFile(session.messages[0].attachments[0].ref, "utf8"), "retained attachment");
        assert.equal(await readFile(join(config.data, "attachments", "迁移 attachment.txt"), "utf8"), "retained attachment");
        assert.equal((await nextHost.call("settings.get")).enterToSend, false);
        const project = join(pointer.roots.data, "projects", "saved project");
        assert.equal((await nextHost.call("project.memory.get", { path: project })).memory.content, "Keep project instructions after moving drives");
      } else {
        await assert.rejects(stat(config.data), { code: "ENOENT" });
        const { session } = await nextHost.call("session.create", { title: "First conversation at the new location" });
        assert(session.id);
      }
      await stopHost(nextHost);
    } finally { await nextHost.stop(); }
    checks.push({ name, passed: true, directory });
  } finally { await host.stop(); }
}
// Retry the reported partially completed cleanup: the old payload is absent,
// while userData still owns the bootstrap pointer and native installation lock.
// Preserve every synthetic profile; no disposable backup payload is created.
{
  const directory = await mkdtemp(join(artifacts, "backup-cleanup-"));
  const config = { directory, anchor: join(directory, "installation"), data: join(directory, "already-removed-data") };
  const active = { data: join(directory, "active-data"), browser: join(directory, "active-browser") };
  await mkdir(config.anchor); await mkdir(active.browser);
  const host = new Host(hostBinary, active.data);
  let sessionId;
  try {
    await host.start();
    const { session } = await host.call("session.create", { title: "History survives backup cleanup" });
    sessionId = session.id;
    await mkdir(join(active.data, "attachments"));
    const attachment = join(active.data, "attachments", "retained.txt");
    await writeFile(attachment, "current attachment");
    await host.call("session.appendMessage", { sessionId, message: { id: "backup-cleanup-fixture", role: "user", content: "Current history stays available", createdAt: new Date().toISOString(), attachments: [{ kind: "file", name: "retained.txt", ref: attachment, mimeType: "text/plain" }] } });
    await stopHost(host);
  } finally { await host.stop(); }
  const preferenceFile = join(config.anchor, "storage-location.json");
  await writeFile(preferenceFile, JSON.stringify({ version: 1, roots: active, backups: [{ data: config.data, browser: config.anchor }] }));
  assert.equal((await launch(config, "backup")).scheduled, true);
  assert.equal(JSON.parse(await readFile(preferenceFile, "utf8")).pending.kind, "backup");
  assert.equal((await launch(config, "maintenance")).relaunched, true);
  const pointer = JSON.parse(await readFile(preferenceFile, "utf8"));
  assert.deepEqual(pointer.roots, active);
  assert.deepEqual(pointer.backups, []);
  assert.equal(pointer.pending, undefined);
  assert.equal(pointer.lastError, undefined);
  const reopened = await launch(config, "inspect-backup");
  assert.equal(reopened.backupControlRemoved, true);
  assert.equal(reopened.sessionData, active.browser);
  assert.equal(reopened.browserState, "browser state survives restart");
  const nextHost = new Host(hostBinary, active.data);
  try {
    await nextHost.start();
    const { session } = await nextHost.call("session.get", { id: sessionId });
    assert.equal(session.messages[0].content, "Current history stays available");
    assert.equal(await readFile(session.messages[0].attachments[0].ref, "utf8"), "current attachment");
    await stopHost(nextHost);
  } finally { await nextHost.stop(); }
  checks.push({ name: "backup-cleanup-with-installation-lock", passed: true, directory });
}
await writeFile(join(artifacts, "result.json"), JSON.stringify({ checks, hostBinary, artifacts }, null, 2));
console.log(JSON.stringify({ checks, hostBinary, artifacts }, null, 2));
