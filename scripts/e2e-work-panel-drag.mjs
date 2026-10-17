import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

// Windows' native hit test is required: DOM geometry alone cannot prove that
// Chromium clipped the excluded drag regions. Python reads only this window.
assert.equal(process.platform, "win32", "Run the native drag regression on Windows");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-work-panel-drag-"));
const styles = await Promise.all(["tokens", "base", "chat-shell", "work-panel"].map((name) =>
  readFile(join(root, "apps/desktop/src/styles/" + name + ".css"), "utf8"),
));
await writeFile(join(temp, "style.css"), styles.join("\n"));
await build({
  entryPoints: [join(root, "scripts/e2e/work-panel-drag.tsx")],
  outfile: join(temp, "renderer.js"),
  bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty" },
  alias: {
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
  },
  nodePaths: [join(root, "apps/desktop/node_modules")],
});
await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>PI Tab Drag Regression</title><link rel="stylesheet" href="style.css"><body><script src="renderer.js"></script>');
await writeFile(join(temp, "hit-test.py"), [
  "import ctypes as c, ctypes.wintypes as w, json, sys",
  "u = c.WinDLL('user32', use_last_error=True)",
  "u.SetProcessDPIAware()",
  "u.ClientToScreen.argtypes = [w.HWND, c.POINTER(w.POINT)]",
  "u.SendMessageTimeoutW.argtypes = [w.HWND, w.UINT, c.c_size_t, c.c_ssize_t, w.UINT, w.UINT, c.POINTER(c.c_size_t)]",
  "u.SendMessageTimeoutW.restype = c.c_ssize_t",
  "hwnd, scale = int(sys.argv[1]), float(sys.argv[2])",
  "origin = w.POINT(0, 0)",
  "if not u.ClientToScreen(hwnd, c.byref(origin)): raise RuntimeError('ClientToScreen failed')",
  "points = json.loads(sys.stdin.read())",
  "for point in points:",
  "    x = origin.x + round(point['x'] * scale)",
  "    y = origin.y + round(point['y'] * scale)",
  "    result = c.c_size_t()",
  "    ok = u.SendMessageTimeoutW(hwnd, 0x84, 0, ((y & 65535) << 16) | (x & 65535), 2, 3000, c.byref(result))",
  "    if not ok: raise RuntimeError('WM_NCHITTEST failed')",
  "    point['actual'] = result.value",
  "print(json.dumps(points))",
].join("\n"));

function electronProbe() {
  const { app, BrowserWindow } = require("electron");
  const { spawn } = require("node:child_process");
  const path = require("node:path");
  app.setPath("userData", path.join(__dirname, "profile"));
  function nativeHits(hwnd, scale, points) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.env.PI_TEST_PYTHON || "python", [path.join(__dirname, "hit-test.py"), hwnd, String(scale)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (data) => out += data);
      child.stderr.on("data", (data) => err += data);
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) return reject(new Error(err || "Native hit test failed"));
        try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(points));
    });
  }
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, frame: false, width: 1000, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const results = [];
    try {
      await window.loadFile(path.join(__dirname, "index.html"));
      window.showInactive();
      const handle = window.getNativeWindowHandle();
      const hwnd = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
      for (const stage of ["overflow-end", "switch-back", "overflow-start", "keyboard-reorder", "one-tab", "no-tabs"]) {
        const points = await window.webContents.executeJavaScript("globalThis.workPanelDragProbe(" + JSON.stringify(stage) + ")");
        await window.webContents.capturePage();
        const scale = await window.webContents.executeJavaScript("devicePixelRatio");
        const hits = await nativeHits(hwnd, scale, points);
        results.push({ stage, hits });
        const failures = hits.filter((point) => point.actual !== point.expected);
        if (failures.length) throw new Error(stage + ": " + JSON.stringify(failures));
      }
      console.log("WORK_PANEL_DRAG_PROBE " + JSON.stringify({ ok: true, results }));
      app.exit(0);
    } catch (error) {
      console.error("WORK_PANEL_DRAG_PROBE " + JSON.stringify({ ok: false, error: String(error), results }));
      app.exit(1);
    }
  });
}
await writeFile(join(temp, "main.cjs"), "(" + electronProbe.toString() + ")();");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => output += data);
const timeout = setTimeout(() => child.kill(), 60_000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const line = output.split(/\r?\n/).find((line) => line.startsWith("WORK_PANEL_DRAG_PROBE "));
  console.log(line ?? output.slice(-6000));
  assert.equal(code, 0, output.slice(-6000));
  assert.ok(line, "Native drag probe did not return results");
} finally {
  clearTimeout(timeout);
  // Retain isolated profiles and evidence for inspection; no user data is used.
  console.log("Drag regression artifacts: " + temp);
}
