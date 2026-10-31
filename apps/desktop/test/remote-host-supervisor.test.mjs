import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildRemoteHostSupervisorScript, parseRemoteHostReady, ensureRemoteHostReady } = await import("../electron/main/remote/remote-host-supervisor.ts");
const VERSION = "0.15.1-beta.5";
const ready = { hostId: "durable-host", host: "127.0.0.1", port: 45678, version: VERSION };
const line = value => `PI_HOST_READY ${JSON.stringify(value)}\n`;

test("readiness validates loopback, integral port, identity and version without leaking output", () => {
  assert.deepEqual(parseRemoteHostReady(line(ready), { version: `v${VERSION}`, expectedHostId: ready.hostId }), ready);
  for (const invalid of [{ host: "0.0.0.0" }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: "42" }, { hostId: " " }, { version: "" }]) {
    assert.throws(() => parseRemoteHostReady(line({ ...ready, ...invalid }), { version: VERSION }), { errorCode: "HOST_BOOTSTRAP_FAILED" });
  }
  for (const output of ["", "PI_HOST_READY {", line(ready) + line(ready), line(ready) + "PI_HOST_PAIRING_TOKEN secret"]) {
    assert.throws(() => parseRemoteHostReady(output, { version: VERSION }), error => !error.message.includes("secret"));
  }
  assert.throws(() => parseRemoteHostReady(line(ready), { version: "other" }), { errorCode: "HOST_VERSION_MISMATCH", retriable: false });
  assert.throws(() => parseRemoteHostReady(line(ready), { version: VERSION, expectedHostId: "other" }), { errorCode: "HOST_AUTH_FAILED", retriable: false });
  assert.throws(() => parseRemoteHostReady(line({ ...ready, version: "older" }), { version: VERSION, expectedHostId: "other" }), { errorCode: "HOST_AUTH_FAILED", retriable: false }, "identity mismatch must not authorize automatic upgrade");
  assert.throws(() => buildRemoteHostSupervisorScript(0));
});

test("supervisor uses bounded stdin execution and refuses nonzero status", async () => {
  const transport = { execWithInput: async (command, script, options) => {
    assert.equal(command, "sh -s");
    assert.equal(options.timeoutMs, 165000);
    assert.equal(options.maxOutputBytes, 16384);
    assert.ok(script.includes('9>&-'));
    return { code: 1, stdout: line(ready), stderr: "private diagnostic" };
  } };
  await assert.rejects(ensureRemoteHostReady(transport, { version: VERSION }), { errorCode: "HOST_BOOTSTRAP_FAILED" });
});

async function fixture(t, { legacy = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "supervisor-"));
  const base = join(home, ".pi-desktop/pi-host");
  const work = join(base, ".bootstrap");
  await mkdir(join(base, "current/bin"), { recursive: true });
  await mkdir(work);
  const credentials = join(home, "credentials");
  await writeFile(credentials, "durable-device-token");
  const entry = join(base, "current/pi-host.js");
  await writeFile(entry, `const fs = require('node:fs');
const net = require('node:net');
if (process.argv.slice(2).join(' ') !== '--port 0') process.exit(2);
let inheritedLock = false;
try { inheritedLock = fs.readlinkSync('/proc/self/fd/9').endsWith('/.deploy.lock'); } catch {}
if (inheritedLock) process.exit(3);
const server = net.createServer();
server.listen(0, '127.0.0.1', () => console.log('PI_HOST_READY ' + JSON.stringify({ hostId: 'durable-host', host: '127.0.0.1', port: server.address().port, version: '${VERSION}' })));
`);
  if (!legacy) await symlink(process.execPath, join(base, "current/bin/node"));
  t.after(async () => {
    const pid = Number(await readFile(join(work, "pi-host.pid"), "utf8").catch(() => "0"));
    if (pid > 0 && pid !== 99999999 && pid !== process.pid) { try { process.kill(pid); } catch {} }
    await rm(home, { recursive: true, force: true });
  });
  const run = () => new Promise((resolve, reject) => {
    const child = spawn("sh", ["-s"], { env: { ...process.env, HOME: home } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(buildRemoteHostSupervisorScript(5));
  });
  return { home, base, work, credentials, run };
}

test("stopped installed Host starts at a fresh port, then running reuse preserves PID and credentials", async t => {
  const f = await fixture(t);
  await writeFile(join(f.work, "pi-host.pid"), "99999999\n");
  await writeFile(join(f.work, "pi-host.log"), line(ready) + "PI_HOST_PAIRING_TOKEN historic-secret\n");
  const first = await f.run();
  assert.equal(first.code, 0, first.stderr);
  const live = parseRemoteHostReady(first.stdout, { version: VERSION });
  assert.notEqual(live.port, ready.port);
  const pid = await readFile(join(f.work, "pi-host.pid"), "utf8");
  // Simulate a bootstrap log that still contains its original pairing token.
  await writeFile(join(f.work, "pi-host.log"), first.stdout + "PI_HOST_PAIRING_TOKEN historic-secret\n");
  const second = await f.run();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(await readFile(join(f.work, "pi-host.pid"), "utf8"), pid);
  assert.equal(await readFile(f.credentials, "utf8"), "durable-device-token");
  assert.ok((await readFile(join(f.work, "pi-host.log"), "utf8")).includes("historic-secret"));
});

test("legacy installed bundle can use system Node without installing", async t => {
  const f = await fixture(t, { legacy: true });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  parseRemoteHostReady(result.stdout, { version: VERSION });
});

test("unrelated live PID is neither killed nor mistaken for an installed Host", async t => {
  const f = await fixture(t);
  await writeFile(join(f.work, "pi-host.pid"), String(process.pid));
  await writeFile(join(f.work, "pi-host.log"), line(ready));
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /host-pid-mismatch/);
  assert.equal(await readFile(join(f.work, "pi-host.log"), "utf8"), line(ready));
});

test("symlinked stale log is rejected without truncating its target", async t => {
  const f = await fixture(t);
  await symlink(f.credentials, join(f.work, "pi-host.log"));
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unsafe-state-file/);
  assert.equal(await readFile(f.credentials, "utf8"), "durable-device-token");
});
