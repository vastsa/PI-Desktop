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
 *      the miss budget — and every ping is answered within a deadline.
 *   2. Parent kill: SIGKILL the Electron main process (no disconnect
 *      handshake, nothing graceful). The orphaned host must exit by itself
 *      within the keepalive budget.
 *
 * Run from apps/desktop (requires `electron` from devDependencies, i.e. a
 * completed `pnpm install`):
 *
 *     node test/plugin-host-parent-kill-acceptance.mjs
 *
 * Exit code 0 = accepted, 1 = rejected (with the reason on stderr). The script
 * needs no app build: it forks `electron/main/plugin-host-process.mjs` directly
 * with a minimal fixture plugin.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
  process.stderr.write(`ACCEPTANCE FAIL: ${message}\n`);
  if (brokerOutput) process.stderr.write(`--- electron output ---\n${brokerOutput}\n`);
  process.exit(1);
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
    "module.exports = { onLoad() { setInterval(() => {}, 1000); } };",
    "utf8",
  );
  writeFileSync(
    join(dir, "broker.cjs"),
    `const { app, utilityProcess } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");

const dir = __dirname;
let answered = 0;

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
    return true;
  } catch {
    return false;
  }
}

const electronBin = findElectronBinary();
if (!electronBin || !existsSync(String(electronBin))) {
  fail(
    "electron binary not found — run `pnpm install` in apps/desktop first, " +
      "or set ELECTRON_BIN. This acceptance must run in an environment with " +
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
try {
  const hostPid = Number(await waitFor(join(dir, "host-pid"), 15000));
  await waitFor(join(dir, "pings-answered"), 15000);
  const firstAnswered = Number(readFileSync(join(dir, "pings-answered"), "utf8"));

  await new Promise((r) => setTimeout(r, HEALTHY_MS));
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
    `phase 1 OK: healthy parent answered ${answeredAfterHealthy} pings; host pid ${hostPid} alive\n`,
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
  process.exit(0);
} catch (error) {
  process.stderr.write(brokerOutput);
  fail(error?.message ?? String(error));
}
