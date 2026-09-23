#!/usr/bin/env node
/**
 * Trusted extensions E2E runner (E2E-241..244).
 *
 * This is intentionally a protocol-driven desktop journey: it launches the
 * real Electron app and renderer, but uses a local deterministic provider stub
 * instead of a cloud model. The fixture seed and driver remain reusable for
 * manual debugging; this runner owns their lifecycle for CI.
 *
 * Prerequisites: built JS packages, the desktop bundle, Electron, and a
 * debug/release host-core binary. The runner does not build the repository.
 * Override PI_DESKTOP_HOST_BIN to select a specific host binary.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const harness = join(root, "apps", "desktop", "test", "e2e", "trusted-extensions");
const configuredRoot = process.env.E2E_ROOT?.trim();
const runRoot = configuredRoot ? resolve(configuredRoot) : mkdtempSync(join(tmpdir(), "pi-ext-e2e-"));
const ownsRoot = !configuredRoot;
const dataDir = join(runRoot, "data");
const homeDir = join(runRoot, "home");
const agentDir = join(homeDir, ".pi", "agent");
const project = join(runRoot, "project");
const requestLog = join(runRoot, "requests.jsonl");
const configuredTimeout = Number(process.env.E2E_TIMEOUT_MS || 180_000);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : 180_000;
const keepArtifacts = process.env.E2E_KEEP_ARTIFACTS === "1";
const debug = process.env.DEBUG_E2E === "1";

const children = new Set();
let stopping = false;

function logDebug(message) {
  if (debug) console.error(`[trusted-extensions] ${message}`);
}

function candidatesFor(configured, names) {
  const paths = [];
  if (configured) {
    const selected = resolve(configured);
    paths.push(selected);
    if (process.platform === "win32" && !selected.toLowerCase().endsWith(".exe")) {
      paths.push(`${selected}.exe`);
    }
  }
  for (const name of names) {
    paths.push(join(root, "target", "debug", name));
    paths.push(join(root, "target", "release", name));
  }
  return paths;
}

function findHostBinary() {
  const name = `pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`;
  return candidatesFor(process.env.PI_DESKTOP_HOST_BIN?.trim(), [name]).find(existsSync);
}

function findElectron() {
  try {
    return resolveElectronBinary(root).electronBinary;
  } catch {
    return null;
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("failed to allocate a loopback port");
  return port;
}

function spawnChild(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.add(child);
  let output = "";
  const capture = (stream, prefix, destination) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
      if (destination) destination.write(chunk);
      if (debug) process.stderr.write(`[${prefix}] ${chunk}`);
    });
  };
  capture(child.stdout, label, options.forwardStdout ? process.stdout : null);
  capture(child.stderr, `${label}:stderr`, options.forwardStderr ? process.stderr : null);
  child.once("error", (error) => {
    logDebug(`${label} error: ${error.message}`);
  });
  child.once("close", () => children.delete(child));
  return { child, getOutput: () => output };
}

function waitForClose(child, waitMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish({ code: child.exitCode, signal: child.signalCode }), waitMs);
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

async function terminateProcess(entry, label) {
  const child = entry?.child || entry;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  logDebug(`stopping ${label}`);
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  await waitForClose(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
    await waitForClose(child, 2_000);
  }
}

async function runCommand(label, command, args, options = {}) {
  const entry = spawnChild(label, command, args, options);
  const result = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      void terminateProcess(entry, label).then(() => reject(new Error(`${label} timed out`)));
    }, options.timeoutMs || timeoutMs);
    entry.child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    entry.child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, output: entry.getOutput() });
    });
  });
  if (result.code !== 0) {
    throw new Error(`${label} exited code=${result.code} signal=${result.signal}\n${result.output}`);
  }
  return result;
}

async function waitForFile(path, predicate, label, waitMs = 90_000, child) {
  const deadline = Date.now() + waitMs;
  let lastError = "file not found";
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${label} process exited code=${child.exitCode} signal=${child.signalCode}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!predicate || predicate(value)) return value;
      lastError = "file contents are not ready";
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${label} not ready: ${lastError}`);
}

async function waitForHttp(url, label, waitMs = 30_000) {
  const deadline = Date.now() + waitMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.arrayBuffer();
      if (response.status < 500) return response.status;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${label} not ready: ${lastError}`);
}

function isolatedEnv(extra = {}) {
  mkdirSync(homeDir, { recursive: true });
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_CODING_AGENT_DIR: agentDir,
  };
}

async function main() {
  const hostBin = findHostBinary();
  const electronBin = findElectron();
  if (!hostBin) {
    throw new Error(`host binary missing; tried ${candidatesFor(process.env.PI_DESKTOP_HOST_BIN?.trim(), [`pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`]).join(", ")}`);
  }
  if (!electronBin) throw new Error("Electron binary missing; install desktop dependencies first");
  assertDesktopBuild(root);

  mkdirSync(runRoot, { recursive: true });
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(requestLog, { force: true });
  const stubPort = await freePort();
  const mcpPort = await freePort();
  const cdpPort = await freePort();
  if (stubPort === mcpPort) throw new Error("allocated duplicate E2E ports");

  await runCommand(
    "trusted-extension-seed",
    process.execPath,
    [join(harness, "seed.mjs")],
    {
      env: isolatedEnv({ E2E_ROOT: runRoot, HOST_BIN: hostBin, STUB_PORT: String(stubPort) }),
      timeoutMs: 60_000,
    },
  );

  spawnChild(
    "trusted-extension-stub",
    process.execPath,
    [join(harness, "stub-server.mjs")],
    {
      env: isolatedEnv({
        STUB_PORT: String(stubPort),
        REQUEST_LOG: requestLog,
      }),
    },
  );
  const stubStatus = await waitForHttp(`http://127.0.0.1:${stubPort}/health`, "provider stub", 30_000);
  if (stubStatus !== 404) throw new Error(`provider stub readiness returned HTTP ${stubStatus}`);

  const electron = spawnChild(
    "trusted-extension-electron",
    electronBin,
    [`--user-data-dir=${join(runRoot, "profile")}`, `--remote-debugging-port=${cdpPort}`, "."],
    {
      cwd: join(root, "apps", "desktop"),
      env: isolatedEnv({
        PI_DESKTOP_HOST_BIN: hostBin,
        PI_DESKTOP_MCP_CONTROL: "1",
        PI_DESKTOP_MCP_PORT: String(mcpPort),
        ELECTRON_RENDERER_URL: "",
        PI_DESKTOP_START_MAXIMIZED: "0",
      }),
    },
  );
  await waitForFile(
    join(dataDir, "mcp-control.json"),
    (info) => {
      try {
        return info?.active === true && typeof info.url === "string" &&
          typeof info.token === "string" && new URL(info.url).port === String(mcpPort);
      } catch {
        return false;
      }
    },
    "MCP control plane",
    90_000,
    electron.child,
  );

  const driverResult = await runCommand(
    "trusted-extension-driver",
    process.execPath,
    [join(harness, "drive.mjs")],
    {
      env: isolatedEnv({ E2E_ROOT: runRoot, E2E_PROJECT: resolve(project), E2E_CDP_PORT: String(cdpPort) }),
      timeoutMs,
      forwardStdout: true,
      forwardStderr: true,
    },
  );
  const summary = /SUMMARY (\d+)\/(\d+) passed/.exec(driverResult.output);
  if (!summary) throw new Error("trusted-extension-driver did not emit a SUMMARY");
  if (summary[1] !== summary[2]) {
    throw new Error(`trusted-extension-driver reported ${summary[1]}/${summary[2]} passed`);
  }
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map((child) => terminateProcess(child, "E2E child")));
  if (!keepArtifacts && ownsRoot) {
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } else {
    console.error(`E2E artifacts retained at ${runRoot}`);
  }
}

try {
  await main();
  console.log("PASS trusted extensions E2E runner");
} catch (error) {
  console.error(`FAIL trusted extensions E2E runner — ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
