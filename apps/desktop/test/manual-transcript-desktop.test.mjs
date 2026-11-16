import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Exercise the launcher failure path without opening another Desktop instance.
test("failed Desktop readiness closes the owned child and saves diagnostics", async () => {
  const source = await readFile(new URL("../../../scripts/manual-transcript-desktop.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("const child = spawn("));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 123;
  let killed = false;
  child.kill = () => { killed = true; child.emit("close", 1); return true; };
  const files = [];
  const process = { argv: [], exitCode: 0 };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("spawn", "electronBinary", "port", "join", "directory", "appDir", "env", "once", "writeFile", "sessions", "waitFor", "process", "console", body);
  let resolveClose;
  const closed = new Promise(resolve => { resolveClose = resolve; });
  child.on("close", resolveClose);
  const running = run(() => child, "electron", 1, (...parts) => parts.join("/"), "fixture", "app", {},
    () => closed, async (path) => { files.push(path); }, [],
    async () => { throw new Error("Synthetic readiness failure"); }, process, { error() {}, log() {} });
  // Flush the immediate readiness rejection; no wall-clock timeout or real process.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const cleanedUp = killed;
  if (!killed) child.emit("close", 1);
  await running;
  assert.equal(cleanedUp, true, "failed readiness must terminate its child before awaiting close");
  assert.equal(process.exitCode, 1);
  assert.ok(files.includes("fixture/desktop.log"));
});
