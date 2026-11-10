import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

register(new URL("helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

async function until(probe, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

// This service keeps a real response open. A host reload kills that response,
// just as unloading a proxy plugin kills the model stream it is forwarding.
const serviceSource = `
const http = require('node:http');
let server;
let count = 0;
module.exports = {
  async onLoad() {
    await pi.services.register({
      id: 'stream',
      start: async () => {
        server = http.createServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: ready\\n\\n');
          const timer = setInterval(() => res.write('data: ' + (++count) + '\\n\\n'), 30);
          res.once('close', () => clearInterval(timer));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await pi.ui.showToast('PORT:' + server.address().port);
      },
      stop: async () => {
        if (!server) return;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        server = null;
      }
    });
  }
};
`;

test("native access-time events preserve a resident stream while edits and unload still take effect", { timeout: 25000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-watch-stream-"));
  const dataDir = mkdtempSync(join(tmpdir(), "pi-watch-stream-data-"));
  const previousData = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = dataDir;
  const id = "com.example.watch-stream";
  const main = join(dir, "main.js");
  const manifestPath = join(dir, "manifest.json");
  const permissions = ["background.service"];
  const manifest = {
    schemaVersion: 1, id, name: "Watch Stream Fixture", version: "0.0.1", main: "main.js",
    permissions, contributes: { services: [{ id: "stream", label: "Stream" }] },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(main, serviceSource);
  const modified = new Date("2026-01-01T00:00:00Z");
  utimesSync(main, modified, modified);
  const audits = [], ports = [], rawEvents = [], children = [], streams = [];
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [] });
      children.push(child);
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    showToast: (message) => { if (message.startsWith("PORT:")) ports.push(Number(message.slice(5))); },
    audit: (entry) => audits.push(entry),
  }, {
    watch: (root, emit) => watch(root, { recursive: true }, (event, name) => {
      rawEvents.push({ event, name: String(name) });
      emit(String(name));
    }),
  });
  t.after(async () => {
    await runtime.disposeAll();
    for (const stream of streams) stream.controller.abort();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await until(() => child.exitCode !== null || child.signalCode !== null, "owned child exit");
      }
    }
    if (previousData === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previousData;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function openStream() {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${ports.at(-1)}/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const state = { controller, chunks: 0, closed: false };
    streams.push(state);
    void (async () => {
      try { for await (const _chunk of response.body) state.chunks++; }
      catch { /* Teardown deliberately interrupts the response. */ }
      finally { state.closed = true; }
    })();
    await until(() => state.chunks > 0, "stream start");
    return state;
  }
  await runtime.loadFromPath(dir, permissions, { development: true });
  runtime.watchDevPlugin(id);
  assert.equal(runtime.isWatchingDevPlugin(id), true);
  const owner = runtime.getLoaded(id);
  const stream = await openStream();
  for (let i = 0; i < 4; i++) {
    utimesSync(main, new Date(modified.getTime() + i * 1000), modified);
    assert.equal(readFileSync(main, "utf8"), serviceSource);
  }
  await until(() => rawEvents.some((row) => row.name === "main.js"), "native metadata notification");
  // Observe beyond two debounce windows to also catch a second reload caused
  // by the plugin loader reading sources during the first reload.
  await delay(650);
  assert.equal(stream.closed, false, "a metadata-only event must not disconnect a resident stream");
  assert.ok(stream.chunks >= 3);
  assert.equal(runtime.getLoaded(id), owner);
  assert.equal(audits.filter((row) => row.api === "plugin.reload.success").length, 0);

  writeFileSync(main, serviceSource + "\n// Actual source edit.\n");
  await until(() => audits.some((row) => row.api === "plugin.reload.success"), "real source reload");
  await until(() => stream.closed, "old stream closed by explicit source edit");
  assert.notEqual(runtime.getLoaded(id), owner);
  const nextOwner = runtime.getLoaded(id);
  const nextStream = await openStream();
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, permissions: [...permissions, "net.fetch"] }));
  await until(() => audits.some((row) => row.api === "plugin.reload.error"), "permission ceiling rejection");
  assert.equal(runtime.getLoaded(id), nextOwner);
  assert.equal(nextStream.closed, false);
  assert.match(audits.find((row) => row.api === "plugin.reload.error").message, /PERMISSION_DENIED/);
  await runtime.unload(id);
  await until(() => nextStream.closed, "stream closed by unload");
  assert.equal(runtime.isWatchingDevPlugin(id), false);
  assert.equal(runtime.getLoaded(id), undefined);
  const loads = audits.filter((row) => row.api === "plugin.load.success").length;
  writeFileSync(main, serviceSource);
  await delay(650);
  assert.equal(audits.filter((row) => row.api === "plugin.load.success").length, loads);
  assert.equal(audits.filter((row) => row.api === "plugin.watch.error").length, 0);
});
