#!/usr/bin/env node
/** Real Chromium persistent state survives the production cold storage bootstrap. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-storage-bootstrap-")));
const anchor = join(scratch, "old-browser");
const data = join(scratch, "old-data");
const target = join(scratch, "destination");
const pointer = join(anchor, "storage-location.json");
try {
  await Promise.all([mkdir(anchor), mkdir(data), mkdir(target)]);
  await writeFile(join(scratch, "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body>Isolated storage test</body></html>');
  await mkdir(join(data, "sessions"));
  await mkdir(join(data, "attachments"));
  await writeFile(join(data, "attachments/test.png"), "fixture attachment");
  await writeFile(join(data, "sessions/chat.jsonl"), JSON.stringify({ type: "message", blocks: [{ type: "attachment", ref: join(data, "attachments/test.png") }] }) + "\n");
  await mkdir(join(data, "cache"));
  await writeFile(join(data, "cache/test.bin"), "disposable");
  const main = join(scratch, "main.mjs");
  await build({ stdin: { contents: `
import { app, BrowserWindow, session } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareStorage } from './apps/desktop/electron/main/storage/bootstrap.ts';
const scratch = process.env.STORAGE_E2E_ROOT;
const anchor = join(scratch, 'old-browser');
const data = join(scratch, 'old-data');
app.setPath('userData', anchor);
let maintenance;
app.on('browser-window-created', (_event, window) => { maintenance = window; });
const originalExit = app.exit.bind(app);
const result = {};
app.relaunch = (options) => { result.relaunched = true; result.relaunchOptions = options; };
app.exit = (code = 0) => {
  void (async () => {
    if (maintenance && !maintenance.isDestroyed()) {
      result.window = { title: maintenance.getTitle(), sandbox: maintenance.webContents.getLastWebPreferences().sandbox,
        persistent: maintenance.webContents.session.isPersistent(),
        view: await maintenance.webContents.executeJavaScript('({heading:document.querySelector("h1")?.textContent, stage:document.getElementById("stage")?.textContent, bytes:document.getElementById("detail")?.textContent, progress:document.querySelector("progress")?.value})') };
    }
    result.pointer = readFileSync(join(anchor, 'storage-location.json'), 'utf8');
    writeFileSync(join(scratch, 'result.json'), JSON.stringify(result));
    originalExit(code);
  })().catch((error) => { console.error(error); originalExit(1); });
};
async function openState(partition, value) {
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,...(partition ? {partition} : {})}});
  await window.loadFile(join(scratch,'index.html'));
  const state = await window.webContents.executeJavaScript(value
    ? 'localStorage.setItem("storage-e2e",'+JSON.stringify(value)+');localStorage.getItem("storage-e2e")'
    : 'localStorage.getItem("storage-e2e")');
  const targetSession = partition ? session.fromPartition(partition) : session.defaultSession;
  targetSession.flushStorageData();
  window.destroy();
  return state;
}
void (async () => {
if (process.env.STORAGE_E2E_MODE === 'seed') {
  await app.whenReady();
  await openState(null, 'main-local-state');
  await openState('persist:storage-e2e-plugin', 'plugin-local-state');
  originalExit(0);
} else {
  const storage = await prepareStorage(data,false);
  await app.whenReady();
  result.roots = storage.preferences.roots;
  result.sessionData = app.getPath('sessionData');
  if (process.env.STORAGE_E2E_MODE === 'read') {
    result.pluginData = session.fromPartition('persist:storage-e2e-plugin').getStoragePath();
  }
  writeFileSync(join(scratch,'result.json'),JSON.stringify(result));
  originalExit(0);
}
})().catch((error) => { console.error(error); originalExit(1); });
`, resolveDir: root, sourcefile: "storage-bootstrap-e2e.mjs", loader: "js" },
    outfile: main, bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"],
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts") },
    plugins: [{ name: "host-binary-location", setup(builder) {
      builder.onResolve({ filter: /host-process$/ }, () => ({ path: "host-binary", namespace: "host-binary" }));
      builder.onLoad({ filter: /.*/, namespace: "host-binary" }, () => ({ contents: "export function resolveHostBinary() { return process.env.PI_DESKTOP_HOST_BIN; }" }));
    } }],
  });
  const hostBinary = process.env.PI_DESKTOP_HOST_BIN ?? join(root, "target/debug/pi-desktop-host-core");
  async function launch(mode) {
    const resultPath = join(scratch, "result.json");
    await rm(resultPath, { force: true });
    const env = { ...process.env, STORAGE_E2E_ROOT: scratch, STORAGE_E2E_MODE: mode, PI_DESKTOP_HOST_BIN: hostBinary };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timeout); }
    assert.equal(code, 0, output);
    if (mode === "seed") return null;
    try { return JSON.parse(await readFile(resultPath, "utf8")); }
    catch (error) { throw new Error(`Electron ${mode} produced no result (exit ${code}): ${output}`, { cause: error }); }
  }
  await launch("seed");
  const sourceTranscript = await readFile(join(data, "sessions/chat.jsonl"), "utf8");
  await writeFile(pointer, JSON.stringify({ version: 1, roots: { data, browser: anchor }, backups: [], pending: { id: randomUUID(), kind: "migrate", target, language: "zh-CN" } }));
  const migrated = await launch("maintenance");
  const preferences = JSON.parse(migrated.pointer);
  assert.equal(preferences.roots.data, join(target, "data"));
  assert.equal(preferences.roots.browser, join(target, "browser"));
  assert.equal(migrated.relaunched, true);
  assert.equal(migrated.window.sandbox, true);
  assert.equal(migrated.window.persistent, false);
  assert.match(migrated.window.view.heading, /迁移|存储|维护/);
  assert.match(migrated.window.view.stage, /完成/);
  assert.equal(await readFile(join(data, "sessions/chat.jsonl"), "utf8"), sourceTranscript);
  assert.match(await readFile(join(target, "data/sessions/chat.jsonl"), "utf8"), /destination\/data\/attachments/);
  await readFile(join(scratch, "index.html"));
  const restarted = await launch("read");
  assert.equal(restarted.sessionData, join(target, "browser"), JSON.stringify(restarted));
  assert.equal(restarted.pluginData, join(target, "browser", "Partitions", "storage-e2e-plugin"));
  for (const name of await (await import("node:fs/promises")).readdir(join(anchor, "Local Storage", "leveldb"))) {
    assert.deepEqual(await readFile(join(target, "browser", "Local Storage", "leveldb", name)), await readFile(join(anchor, "Local Storage", "leveldb", name)));
  }
  preferences.pending = { id: randomUUID(), kind: "cache", language: "en" };
  await writeFile(pointer, JSON.stringify(preferences));
  await launch("maintenance");
  await assert.rejects(readFile(join(target, "data/cache/test.bin")), { code: "ENOENT" });
  assert.equal((await launch("read")).pluginData, join(target, "browser", "Partitions", "storage-e2e-plugin"));
  const next = JSON.parse(await readFile(pointer, "utf8"));
  next.pending = { id: randomUUID(), kind: "backup", language: "en" };
  await writeFile(pointer, JSON.stringify(next));
  await launch("maintenance");
  await assert.rejects(readFile(join(data, "sessions/chat.jsonl")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(pointer, "utf8")).backups, []);
  assert.equal((await launch("read")).sessionData, join(target, "browser"));
  console.log("STORAGE_BOOTSTRAP " + JSON.stringify({ migration: true, progress: true, chromiumState: true, pluginState: true, safeCache: true, backupCleanup: true }));
} finally { await rm(scratch, { recursive: true, force: true }); }
