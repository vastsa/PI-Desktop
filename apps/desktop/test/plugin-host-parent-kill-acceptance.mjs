/**
 * Acceptance: the Electron plugin host must not outlive an abruptly killed
 * parent (ADR 0008 / PR #2381 review item ④).
 *
 * Electron's `utilityProcess` child never sees a JavaScript-visible
 * `disconnect` — the pinned parent-port just goes dead — so the host relies on
 * its ping/pong keepalive plus the parent-port `close` event. This script
 * proves both, against the real Electron runtime:
 *
 *   1. Healthy-parent responsiveness: with the broker answering every `ping`
 *      with a `pong`, the host keeps round-tripping and stays alive well past
 *      the miss budget. Registration, panel calls, and exception reporting
 *      still work over the real parent-port transport.
 *   2. Parent kill: SIGKILL the Electron main process (no disconnect
 *      handshake, nothing graceful). The orphaned host must exit by itself
 *      within the keepalive budget.
 *
 * Run from apps/desktop using the provisioned Electron runtime (or set
 * ELECTRON_BIN to its executable):
 *
 *     node test/plugin-host-parent-kill-acceptance.mjs
 *
 * Exit code 0 = accepted, 1 = rejected (with the reason on stderr). The script
 * needs no app build: it forks `electron/main/plugin-host-process.mjs` directly
 * with a minimal fixture plugin.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(join(here, ".."));
const hostEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

// Keepalive tuned for a fast acceptance run: 1s interval, 2 misses → an
// orphaned host must be gone within roughly 3s plus slack.
const PING_INTERVAL_MS = 1000;
const PING_MISSES = 2;
const KILL_GRACE_MS = PING_INTERVAL_MS * (PING_MISSES + 2) + 3000;
const HEALTHY_MS = PING_INTERVAL_MS * (PING_MISSES + 1) + 1000;
const PONG_DEADLINE_MS = 3000;

function fail(message) {
  throw new Error(`ACCEPTANCE FAIL: ${message}`);
}

function findElectronBinary() {
  if (process.env.ELECTRON_BIN) return process.env.ELECTRON_BIN;
  try {
    const require = createRequire(join(desktopRoot, "package.json"));
    // The `electron` package's index resolves to the installed binary path.
    return require("electron");
  } catch {
    return null;
  }
}

// Minimal broker main for Electron: answers pings, relays diagnostics, and
// records the host's pid so the outer driver can watch it after the kill.
function writeBrokerMain(dir) {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, id: "fixture.parentkill", name: "ParentKill", version: "0.0.1", main: "main.js" }),
    "utf8",
  );
  // Referenced timer: proves liveness comes from the transport, not the plugin.
  writeFileSync(
    join(dir, "main.js"),
    `module.exports = {
      async onLoad() {
        setInterval(() => {}, 1000);
        await pi.commands.register({ id: "fixture.ping", title: "Ping", run() { return "pong"; } });
      },
      onPanelInvoke(channel, payload) {
        if (channel === "exception") {
          setImmediate(() => { throw new Error("fixture native exception"); });
          return null;
        }
        return payload.value;
      },
    };`,
    "utf8",
  );
  writeFileSync(
    join(dir, "broker.cjs"),
    `const { app, utilityProcess } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");

const dir = __dirname;
let answered = 0;
let calls = 0;
let initialized = false;
let exceptionTriggered = false;
app.setPath("userData", join(dir, "profile"));
writeFileSync(join(dir, "electron-version"), process.versions.electron);

function reject(message) {
  writeFileSync(join(dir, "failure"), message);
  app.exit(1);
}

app.whenReady().then(() => {
  const child = utilityProcess.fork(${JSON.stringify(hostEntry)}, [], {
    serviceName: "fixture-parent-kill",
    stdio: "inherit",
    env: {
      ...process.env,
      PI_PLUGIN_PING_INTERVAL_MS: String(${PING_INTERVAL_MS}),
      PI_PLUGIN_PING_MISSES: String(${PING_MISSES}),
    },
  });
  child.on("spawn", () => {
    writeFileSync(join(dir, "host-pid"), String(child.pid));
  });
  child.on("message", (message) => {
    if (message && message.t === "ping") {
      answered += 1;
      child.postMessage({ t: "pong", id: message.id });
      writeFileSync(join(dir, "pings-answered"), String(answered));
      writeFileSync(join(dir, "last-pong-at"), String(Date.now()));
      if (initialized) {
        const id = "health-" + answered;
        child.postMessage({ t: "call", id, method: "panel.invoke", payload: { channel: "echo", payload: { value: id } } });
      }
    } else if (message.t === "call") {
      if (message.api !== "commands.register") return reject("unexpected host API: " + message.api);
      child.postMessage({ t: "res", id: message.id, ok: true, value: null });
      writeFileSync(join(dir, "registration"), "ok");
    } else if (message.t === "res") {
      if (!message.ok) return reject(JSON.stringify(message));
      if (message.id === 1) initialized = true;
      if (String(message.id).startsWith("health-")) {
        if (message.value !== message.id) return reject("panel response did not match its request");
        writeFileSync(join(dir, "healthy-calls"), String(++calls));
        if (!exceptionTriggered) {
          exceptionTriggered = true;
          child.postMessage({ t: "call", id: "exception", method: "panel.invoke", payload: { channel: "exception" } });
        }
      }
    } else if (message.t === "log" && message.message.includes("fixture native exception")) {
      writeFileSync(join(dir, "exception-reported"), "ok");
    } else {
      process.stdout.write("host: " + JSON.stringify(message) + "\\n");
    }
  });
  child.on("exit", (code) => {
    writeFileSync(join(dir, "host-exit"), String(code));
  });
  child.postMessage({
    t: "init",
    id: 1,
    pluginId: "fixture.parentkill",
    pluginPath: dir,
    main: "main.js",
  });
});
`,
    "utf8",
  );
  return join(dir, "broker.cjs");
}

function waitFor(predicateFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = () => {
      const failureFile = join(dirname(predicateFile), "failure");
      if (existsSync(failureFile)) return rejectPromise(new Error(readFileSync(failureFile, "utf8")));
      try {
        const content = readFileSync(predicateFile, "utf8").trim();
        if (content) return resolvePromise(content);
      } catch {
        // Not written yet.
      }
      if (Date.now() > deadline) return rejectPromise(new Error(`timed out waiting for ${predicateFile}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    // Linux runners can leave a dead orphan as a zombie until PID 1 reaps it.
    if (process.platform === "linux") {
      const state = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
      if (/^Z/.test(state.stdout.trim())) return false;
    }
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

const electronBin = findElectronBinary();
if (!electronBin || !existsSync(String(electronBin))) {
  fail(
    "electron binary not found — restore the provisioned runtime or set ELECTRON_BIN. " +
      "This acceptance must run in an environment with " +
      "the real Electron runtime (it cannot run in a sandbox without Electron).",
  );
}

const dir = mkdtempSync(join(tmpdir(), "pi-parent-kill-"));
const brokerMain = writeBrokerMain(dir);
// Electron refuses to start as root without this flag (Linux CI containers).
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const electron = spawn(String(electronBin), [...(isRoot ? ["--no-sandbox"] : []), brokerMain], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
let brokerOutput = "";
const electronExited = new Promise((resolveExit) => {
  electron.once("exit", resolveExit);
  electron.once("error", (error) => { brokerOutput += String(error); resolveExit(); });
});
electron.stdout.on("data", (chunk) => {
  brokerOutput += String(chunk);
});
electron.stderr.on("data", (chunk) => {
  brokerOutput += String(chunk);
});

// --- Phase 1: healthy-parent responsiveness --------------------------------
// Wait for the first answered keepalive round-trip, then confirm the
// round-trip keeps flowing (host still alive several intervals later) and
// that no pong was missed (pings answered keeps increasing past the miss
// budget — an unresponsive parent would have let the host exit instead).
let hostPid;
try {
  hostPid = Number(await waitFor(join(dir, "host-pid"), 15000));
  await waitFor(join(dir, "pings-answered"), 15000);
  const firstAnswered = Number(readFileSync(join(dir, "pings-answered"), "utf8"));

  await waitFor(join(dir, "registration"), 3000);
  await waitFor(join(dir, "exception-reported"), 3000);
  await waitFor(join(dir, "healthy-calls"), 3000);
  const healthyDeadline = Date.now() + HEALTHY_MS + 10000;
  while (Number(readFileSync(join(dir, "pings-answered"), "utf8")) < firstAnswered + PING_MISSES + 2 ||
    Number(readFileSync(join(dir, "healthy-calls"), "utf8")) < PING_MISSES + 2) {
    if (Date.now() > healthyDeadline) fail("healthy-parent heartbeat round-trips stalled");
    await new Promise((r) => setTimeout(r, 100));
  }
  const healthyCalls = Number(await waitFor(join(dir, "healthy-calls"), 3000));
  if (healthyCalls < PING_MISSES + 2) fail("healthy parent stopped completing panel calls");
  const answeredAfterHealthy = Number(readFileSync(join(dir, "pings-answered"), "utf8"));
  if (answeredAfterHealthy <= firstAnswered) {
    fail(`healthy parent received no further pings after the first (${answeredAfterHealthy}/${firstAnswered})`);
  }
  if (!pidAlive(hostPid)) {
    fail("host exited while the parent was healthy and answering pings");
  }
  // Responsiveness deadline: the last pong must be recent — the broker answers
  // synchronously on message receipt, so a stale last-pong-at means pings
  // stopped flowing.
  const lastPongAt = Number(readFileSync(join(dir, "last-pong-at"), "utf8"));
  if (Date.now() - lastPongAt > PONG_DEADLINE_MS) {
    fail(`healthy-parent pong round-trips stalled (${Date.now() - lastPongAt}ms since last pong)`);
  }
  process.stdout.write(
    `phase 1 OK: Electron ${readFileSync(join(dir, "electron-version"), "utf8")}; ${answeredAfterHealthy} pings, ` +
      `${healthyCalls} panel calls, registration and exception recovery; host pid ${hostPid} alive\n`,
  );

  // --- Phase 2: parent kill ------------------------------------------------
  // SIGKILL: no disconnect handshake, no graceful teardown — the exact case
  // Electron's pinned parent-port cannot signal to the host.
  process.kill(electron.pid, "SIGKILL");
  const startedAt = Date.now();
  const deadline = startedAt + KILL_GRACE_MS;
  while (pidAlive(hostPid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pidAlive(hostPid)) {
    fail(`orphaned host pid ${hostPid} still alive ${KILL_GRACE_MS}ms after the parent was SIGKILLed`);
  }
  const exitCode = existsSync(join(dir, "host-exit")) ? readFileSync(join(dir, "host-exit"), "utf8") : "(no exit record)";
  process.stdout.write(
    `phase 2 OK: orphaned host exited on its own after ${Date.now() - startedAt}ms (exit record: ${exitCode})\n`,
  );
  process.stdout.write("ACCEPTANCE PASS\n");
} catch (error) {
  process.stderr.write(brokerOutput);
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
} finally {
  // Every failure path owns and reaps its test processes before removing files.
  if (electron.exitCode === null && electron.signalCode === null) electron.kill("SIGKILL");
  await electronExited;
  if (!hostPid && existsSync(join(dir, "host-pid"))) hostPid = Number(readFileSync(join(dir, "host-pid"), "utf8"));
  if (hostPid && pidAlive(hostPid)) process.kill(hostPid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
