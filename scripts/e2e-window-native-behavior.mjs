#!/usr/bin/env node
/** Isolated native window lifecycle; never attaches to a running Desktop. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("esbuild");
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-native-window-"));
const fixture = join(directory, "main.cjs");
try {
  await build({
    stdin: {
      resolveDir: root,
      contents: `
const assert = require("node:assert/strict");
const { app, BrowserWindow, screen } = require("electron");
const { installMaximizedWindowGuard, nativeWindowMinimumSize } = require("./apps/desktop/electron/main/window-native-behavior.ts");
app.on("window-all-closed", () => {});
function transition(window, action, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Timed out: " + event)); }, 10000);
    const done = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timeout); window.removeListener(event, done); };
    window.once(event, done);
    action();
  });
}
app.whenReady().then(async () => {
  // Reproduce the original native constraint before exercising the repair.
  const baseline = new BrowserWindow({ width: 900, height: 650, minWidth: 800, show: false });
  baseline.setSize(704, 650);
  assert.equal(baseline.getBounds().width, 800, "baseline: native minimum rejects a half-width tile");
  baseline.destroy();
  for (const transparent of process.platform === "darwin" ? [false, true] : [false]) {
    const minimum = nativeWindowMinimumSize({ width: 800, height: 560 }, { width: 1440, height: 900 }, process.platform);
    const window = new BrowserWindow({
      width: 900, height: 650, minWidth: minimum.width, minHeight: minimum.height,
      title: "PI isolated native window test", resizable: true,
      ...(process.platform === "darwin" ? {
        titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 12 },
        transparent, ...(transparent ? { vibrancy: "sidebar" } : {}),
      } : { frame: false }),
      webPreferences: { sandbox: true },
    });
    installMaximizedWindowGuard(window, process.platform);
    await window.loadURL("data:text/html,<style>body{margin:0}.drag{height:46px;-webkit-app-region:drag}</style><div class=drag>Isolated native window test</div>");
    await window.webContents.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    window.setSize(704, 650);
    assert.ok(window.getBounds().width <= 720, "native half-width tile is not blocked by the old 800 DIP minimum");
    const normalBounds = window.getBounds();
    await transition(window, () => window.maximize(), "maximize");
    assert.equal(window.isMaximized(), true);
    assert.equal(window.isResizable(), true, "native restore/green button is not disabled");
    if (process.platform === "darwin") {
      assert.equal(window.isMovable(), true, "native zoom remains available; renderer owns caption locking");
      assert.equal(window.isMaximizable(), true, "green button remains available");
    }
    await transition(window, () => window.unmaximize(), "unmaximize");
    assert.equal(window.isMaximized(), false);
    if (process.platform === "darwin") {
      assert.deepEqual(window.getBounds(), normalBounds, "macOS Zoom must restore the entire window frame");
      assert.equal(window.isMovable(), true);
    }
    window.setSize(900, 650);
    assert.equal(window.getBounds().width, 900, "restored window can resize again");
    window.destroy();
    console.log("PASS native maximize/restore and half-width minimum: " + process.platform + ", transparent=" + transparent);
  }
  console.log("Environment: Electron " + process.versions.electron + ", " + JSON.stringify(screen.getPrimaryDisplay().workArea));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`,
    },
    outfile: fixture, bundle: true, platform: "node", format: "cjs", external: ["electron"],
  });
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
  const result = await promisify(execFile)(resolveElectronBinary(root).electronBinary,
    [fixture, `--user-data-dir=${join(directory, "profile")}`], { env, timeout: 60000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.match(result.stdout, /PASS native maximize\/restore/);
} finally {
  await rm(directory, { recursive: true, force: true });
}
