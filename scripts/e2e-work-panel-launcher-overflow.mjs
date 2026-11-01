import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-launcher-overflow-"));
const scenarios = [
  { count: 40, width: 244, height: 260, explicitTab: false, theme: "light", language: "en" },
  { count: 40, width: 360, height: 320, explicitTab: true, theme: "dark", language: "zh-CN" },
  { count: 40, width: 720, height: 600, explicitTab: true, theme: "light", language: "en" },
  { count: 3, width: 244, height: 520, explicitTab: false, theme: "dark", language: "zh-CN" },
  { count: 0, width: 360, height: 260, explicitTab: true, theme: "light", language: "en" },
];
try {
  const styles = await Promise.all(
    ["tokens", "base", "chat-shell", "ui-kit", "work-panel"].map((name) =>
      readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8"),
    ),
  );
  await writeFile(join(temp, "style.css"), styles.join("\n"));
  await build({
    entryPoints: [join(root, "scripts/e2e/work-panel-launcher-overflow.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>Work panel launcher overflow regression</title><link rel="stylesheet" href="style.css"><body><script src="renderer.js"></script>');
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    for (const scenario of ${JSON.stringify(scenarios)}) {
      const result = await window.webContents.executeJavaScript(
        "globalThis.launcherOverflowProbe(" + JSON.stringify(scenario) + ")");
      console.log("LAUNCHER_OVERFLOW " + JSON.stringify({ ...scenario, ...result }));
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => { output += data; });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const results = output.split(/\r?\n/).filter((line) => line.startsWith("LAUNCHER_OVERFLOW "));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(results.length, scenarios.length, "Not all launcher scenarios ran");
  for (const line of results) {
    assert.equal(JSON.parse(line.slice("LAUNCHER_OVERFLOW ".length)).ok, true);
    console.log(line);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
