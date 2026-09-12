#!/usr/bin/env node
/**
 * Crash-supervision smoke: boots the app, has the main process SIGKILL its
 * own host-core child (PI_DESKTOP_SUPERVISION_PROBE=1), and asserts the
 * supervisor restarts it and RPCs recover (SUPERVISION_PROBE line).
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

const dataDir = createTempDataDir("pi-desktop-sup-");
const child = spawn(electronBin, ["."], {
  cwd: appDir,
  env: {
    ...process.env,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_SUPERVISION_PROBE: "1",
    ELECTRON_RENDERER_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let probe = null;
let out = "";

const timeout = setTimeout(() => {
  console.error("FAIL supervision-probe — timeout after 60s");
  console.error(out.slice(-2000));
  child.kill("SIGKILL");
  cleanup(1);
}, 60_000);

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
    const m = text.match(/SUPERVISION_PROBE (.*)/);
    if (m) {
      try {
        probe = JSON.parse(m[1]);
      } catch {}
    }
  });
}

child.on("exit", () => {
  if (probe?.ok) {
    console.log("PASS supervision-probe — host-core restarted and healthy");
    cleanup(0);
  } else {
    console.error("FAIL supervision-probe —", JSON.stringify(probe));
    console.error(out.slice(-2000));
    cleanup(1);
  }
});
