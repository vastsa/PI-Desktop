#!/usr/bin/env node
/**
 * Electron boot smoke: launches the built desktop app with a throwaway
 * profile and asserts the sandboxed preload bridge, IPC round-trips, and
 * E2E-SESSION-list-refresh-keeps-desktop-responsive against 800 synthetic
 * sessions (BOOT_PROBE emitted by electron/main/bootstrap/startup.ts).
 *
 * Prereqs: `pnpm --filter @pi-desktop/desktop build` and a host-core binary
 * (target/debug or target/release, or PI_DESKTOP_HOST_BIN).
 */
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTempDataDir,
  repositoryRoot,
  resolveElectronBinary,
} from "./e2e/boot.mjs";

const root = repositoryRoot();
const { appDir, electronBinary: electronBin } = resolveElectronBinary(root);

if (!existsSync(join(appDir, "out/main/index.js"))) {
  console.error("desktop app not built. Run: pnpm --filter @pi-desktop/desktop build");
  process.exit(1);
}
if (!existsSync(electronBin)) {
  console.error("Electron binary missing:", electronBin);
  process.exit(1);
}

const dataDir = createTempDataDir("pi-desktop-boot-");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBin, ["."], {
  cwd: appDir,
  env: {
    ...env,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_BOOT_PROBE: "1",
    PI_DESKTOP_START_MAXIMIZED: process.platform === "darwin" ? "0" : "1",
    // never inherit a dev-server URL: probe the packaged renderer path
    ELECTRON_RENDERER_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let probe = null;
let out = "";
const pendingLines = new Map();

const timeout = setTimeout(() => {
  console.error("FAIL boot-probe — timeout after 45s");
  console.error(out.slice(-2000));
  child.kill("SIGKILL");
  cleanup(1);
}, 45_000);

function cleanup(code) {
  clearTimeout(timeout);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (buf) => {
    const text = String(buf);
    out += text;
    const lines = `${pendingLines.get(stream) ?? ""}${text}`.split(/\r?\n/);
    pendingLines.set(stream, lines.pop());
    for (const line of lines) {
      if (!line.startsWith("BOOT_PROBE ")) continue;
      try { probe = JSON.parse(line.slice("BOOT_PROBE ".length)); } catch {}
    }
  });
}

child.on("close", (code) => {
  const menuContractOk =
    process.platform === "darwin" ? probe?.menuCount >= 6 : probe?.menuCount === 0;
  const sessions = probe?.sessionList;
  const sessionListOk =
    sessions?.seededCount === 800 &&
    sessions.returnedCount >= 800 &&
    sessions.refreshCount === 8 &&
    sessions.distinctModels >= 2 &&
    sessions.complete === true &&
    sessions.capabilitiesConsistent === true &&
    sessions.mainTicks > 0 &&
    sessions.maxMainGapMs < 1000 &&
    sessions.heartbeatDurationsMs.length > 0 &&
    sessions.heartbeatDurationsMs.every((duration) => duration < 1000);
  if (
    code === 0 &&
    probe?.ok &&
    probe.appName === "PI-Desktop" &&
    probe.platform === process.platform &&
    (process.platform === "darwin" || probe.maximized === true) &&
    menuContractOk &&
    sessionListOk
  ) {
    const menuDetail =
      process.platform === "darwin"
        ? `${probe.menuCount} native menu groups`
        : "menu-free frameless chrome";
    console.log(
      `PASS boot-probe — app v${probe.version}, host protocol ${probe.hostProtocol}, ` +
        `${menuDetail} on ${probe.platform}`,
    );
    console.log(
      "PASS E2E-SESSION-list-refresh-keeps-desktop-responsive — " + JSON.stringify(sessions),
    );
    cleanup(0);
  } else {
    console.error("FAIL boot-probe —", JSON.stringify(probe));
    console.error(out.slice(-2000));
    cleanup(1);
  }
});
