#!/usr/bin/env node
/**
 * Electron boot smoke: launches the built desktop app with a throwaway
 * profile and asserts the sandboxed preload bridge + one IPC round-trip
 * (BOOT_PROBE line emitted by the main process, see electron/main/index.ts).
 *
 * Prereqs: `pnpm --filter @pi-desktop/desktop build` and a host-core binary
 * (target/debug or target/release, or PI_DESKTOP_HOST_BIN).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const appDir = join(root, "apps/desktop");
const electronBin =
  process.platform === "win32"
    ? join(appDir, "node_modules/electron/dist/electron.exe")
    : join(appDir, "node_modules/.bin/electron");

if (!existsSync(join(appDir, "out/main/index.js"))) {
  console.error("desktop app not built. Run: pnpm --filter @pi-desktop/desktop build");
  process.exit(1);
}
if (!existsSync(electronBin)) {
  console.error("Electron binary missing:", electronBin);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-desktop-boot-"));
const child = spawn(electronBin, ["."], {
  cwd: appDir,
  env: {
    ...process.env,
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
    const m = text.match(/BOOT_PROBE (.*)/);
    if (m) {
      try {
        probe = JSON.parse(m[1]);
      } catch {}
    }
  });
}

child.on("exit", () => {
  const menuContractOk =
    process.platform === "darwin" ? probe?.menuCount >= 6 : probe?.menuCount === 0;
  if (
    probe?.ok &&
    probe.appName === "PI-Desktop" &&
    probe.platform === process.platform &&
    (process.platform === "darwin" || probe.maximized === true) &&
    menuContractOk
  ) {
    const menuDetail =
      process.platform === "darwin"
        ? `${probe.menuCount} native menu groups`
        : "menu-free frameless chrome";
    console.log(
      `PASS boot-probe — app v${probe.version}, host protocol ${probe.hostProtocol}, ` +
        `${menuDetail} on ${probe.platform}`,
    );
    cleanup(0);
  } else {
    console.error("FAIL boot-probe —", JSON.stringify(probe));
    console.error(out.slice(-2000));
    cleanup(1);
  }
});
