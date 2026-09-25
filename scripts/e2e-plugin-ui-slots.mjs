#!/usr/bin/env node
/**
 * Plugin UI slots E2E runner (E2E-PLUGIN-ui-slots-*).
 *
 * Launches the real Electron app with the UI Slots Lab loaded as a dev plugin
 * and a deterministic in-process model stub, then drives every renderer slot
 * through the MCP control plane and the renderer DOM (Chrome DevTools
 * Protocol). See apps/desktop/test/e2e/plugin-ui-slots/README.md.
 *
 * Prerequisites: built JS packages, the desktop bundle, Electron, and a
 * host-core binary (PI_DESKTOP_HOST_BIN overrides the lookup). The runner
 * does not build the repository.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectControl, connectRenderer } from "../apps/desktop/test/e2e/plugin-ui-slots/clients.mjs";
import { drive } from "../apps/desktop/test/e2e/plugin-ui-slots/drive.mjs";
import { seed } from "../apps/desktop/test/e2e/plugin-ui-slots/seed.mjs";
import { startStubModel } from "../apps/desktop/test/e2e/plugin-ui-slots/stub-model.mjs";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const configuredRoot = process.env.E2E_ROOT?.trim();
const runRoot = configuredRoot ? resolve(configuredRoot) : mkdtempSync(join(tmpdir(), "pi-ui-slots-e2e-"));
const dataDir = join(runRoot, "data");
const homeDir = join(runRoot, "home");
const keepArtifacts = process.env.E2E_KEEP_ARTIFACTS === "1";
const debug = process.env.DEBUG_E2E === "1";
const configuredTimeout = Number(process.env.E2E_TIMEOUT_MS || 240_000);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 240_000;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

function isolatedEnv(extra) {
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
    PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
  };
}

function launchElectron(electronBinary, hostBin, mcpPort, cdpPort) {
  const child = spawn(
    electronBinary,
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
      if (debug) process.stderr.write(`[electron] ${chunk}`);
    });
  }
  return { child, output: () => output };
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => child.once("close", done));
  const kill = (signal) => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  kill("SIGTERM");
  const timedOut = await Promise.race([closed.then(() => false), new Promise((done) => setTimeout(() => done(true), 3_000))]);
  if (timedOut) {
    kill("SIGKILL");
    await closed;
  }
}

async function waitForControl(mcpPort, electron) {
  const deadline = Date.now() + 90_000;
  let last = "file not found";
  while (Date.now() < deadline) {
    if (electron.child.exitCode !== null) throw new Error(`Electron exited early:\n${electron.output()}`);
    try {
      const info = JSON.parse(readFileSync(join(dataDir, "mcp-control.json"), "utf8"));
      if (info?.active === true && typeof info.token === "string" && new URL(info.url).port === String(mcpPort)) return;
      last = "control plane not active";
    } catch (error) {
      last = error.message;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`MCP control plane not ready: ${last}`);
}

async function main() {
  const hostBin = resolveHostBinary();
  const { electronBinary } = resolveElectronBinary(root);
  assertDesktopBuild(root);
  mkdirSync(runRoot, { recursive: true });

  const stub = await startStubModel();
  let electron;
  let renderer;
  try {
    const { project } = await seed({
      hostBin,
      dataDir,
      runRoot,
      labDir: join(root, "examples", "plugins", "ui-slots-lab"),
      stubPort: stub.port,
    });
    const mcpPort = await freePort();
    const cdpPort = await freePort();
    electron = launchElectron(electronBinary, hostBin, mcpPort, cdpPort);
    await waitForControl(mcpPort, electron);
    const control = await connectControl(dataDir);
    renderer = await connectRenderer(cdpPort);
    let timer;
    const budget = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`drive exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([drive({ control, renderer, check, project }), budget]);
    } finally {
      clearTimeout(timer);
      const shot = join(runRoot, "final.png");
      await renderer
        .screenshot()
        .then((data) => writeFileSync(shot, Buffer.from(data, "base64")))
        .catch(() => {});
    }
  } finally {
    renderer?.close();
    await stop(electron?.child);
    await stub.close();
  }
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`FAIL plugin UI slots E2E runner — ${error?.stack || error}`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`SUMMARY ${passed}/${results.length} passed`);
if (failed || passed !== results.length || results.length === 0) {
  process.exitCode = 1;
  console.error(`E2E artifacts retained at ${runRoot}`);
} else if (!keepArtifacts && !configuredRoot) {
  rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} else {
  console.error(`E2E artifacts retained at ${runRoot}`);
}
