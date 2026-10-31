import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { readNdjsonLines } from "@pi-desktop/shared";

const source = await readFile(new URL("../../../scripts/e2e-smoke.mjs", import.meta.url), "utf8");
const start = source.indexOf("class Host {");
const end = source.indexOf("\nasync function main()", start);
assert.ok(start >= 0 && end > start, "smoke client boundary exists");

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  t.after(() => {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
  let id = 0;
  // Exercise the shipped client with real streams/NDJSON; mock only the child
  // process and clock, not its request, response, or timeout implementation.
  const Host = vm.runInNewContext(`${source.slice(start, end)}\nHost`, {
    spawn: () => child, randomUUID: () => String(++id), readNdjsonLines,
    process: { env: {} }, setTimeout: globalThis.setTimeout, console,
  });
  return { host: new Host("fixture-host", "fixture-data"), child };
}

test("smoke handshake can survive a thirty-second cold start with its explicit setup budget", async (t) => {
  const { host, child } = fixture(t);
  let settled = false;
  const result = host.call("app.handshake", { protocolVersion: 11 }, 45_000);
  result.then(() => { settled = true; }, () => { settled = true; });
  const request = JSON.parse(child.stdin.read().toString("utf8"));
  t.mock.timers.tick(30_001);
  await Promise.resolve();
  assert.equal(settled, false, "the setup budget must exceed the standalone Host cold start");
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 11 } })}\n`);
  assert.equal((await result).protocolVersion, 11);
  assert.match(source, /host\.call\("app\.handshake",\s*\{\s*protocolVersion: PROTOCOL_VERSION,?\s*\},\s*45_000\)/);
});

test("ordinary smoke calls retain their thirty-second timeout", async (t) => {
  const { host } = fixture(t);
  let settled = false;
  const result = host.call("app.health").then(
    () => ({ ok: true }),
    (error) => { settled = true; return { ok: false, message: error.message }; },
  );
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal((await result).message, "timeout app.health");
});
