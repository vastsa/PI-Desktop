import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

function writeFixturePlugin() {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-lifetime-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, id: "fixture.lifetime", name: "Lifetime", version: "0.0.1", main: "main.js" }),
    "utf8",
  );
  // A referenced timer would keep a plain Node host alive forever; the real
  // plugin host must exit with its parent regardless of plugin activity.
  writeFileSync(
    join(dir, "main.js"),
    "module.exports = { onLoad() { setInterval(() => {}, 1000); } };",
    "utf8",
  );
  return dir;
}

function forkHost(extraEnv = {}) {
  const child = fork(hostProcessEntry, [], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ...extraEnv },
  });
  return child;
}

test("plugin host exits when the parent disconnects despite a referenced plugin timer", async () => {
  const dir = writeFixturePlugin();
  const child = forkHost();
  const exited = once(child, "exit");
  const ready = once(child, "message");
  child.send({ t: "init", id: 1, pluginId: "fixture.lifetime", pluginPath: dir, main: "main.js" });
  const [initReply] = await ready;
  assert.equal(initReply.ok, true, "fixture plugin should load");
  // Dropping the IPC side is what a dying parent's connector looks like.
  child.disconnect();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 2000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, "host must exit cleanly on parent disconnect");
});

test("plugin host exits when a send to the parent channel fails", async () => {
  const dir = writeFixturePlugin();
  const child = forkHost();
  const exited = once(child, "exit");
  const ready = once(child, "message");
  child.send({ t: "init", id: 1, pluginId: "fixture.lifetime", pluginPath: dir, main: "main.js" });
  await ready;
  // Same close as a dead parent, but without the disconnect handshake order.
  child._channel?.close?.();
  child.disconnect();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 2000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0);
});
