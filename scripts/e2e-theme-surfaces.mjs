#!/usr/bin/env node
/** Real Chromium cascade regression for token-driven chrome surfaces (E2E-078). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const probeName = process.argv.includes("--dock-mask-only")
  ? "themeDockMaskProbe"
  : "themeSurfacesProbe";
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-theme-surfaces-"));
try {
  await cp(join(root, "scripts/e2e/theme-surfaces.js"), join(temp, "renderer.js"));
  // Use the built app's complete CSS, including the Tailwind reset.
  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app with pnpm build:js before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Theme surface regression</title>${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<style>body { padding: 32px; display: flex; gap: 32px; align-items: flex-start; } .fixture-controls { width: 420px; display: grid; gap: 24px; } .fixture-prose { width: 420px; display: grid; gap: 12px; } .settings-shell-full { width: 275px; height: 340px; } .settings-toggle { margin: 20px; } /* Fixed/absolute app layers stay in flow here so they do not cover other fixtures. Only position changes, never paint. */ .fixture-controls .overlay, .fixture-controls .plugins-modal-backdrop, .fixture-controls .composer-dock-docked { position: static; inset: auto; padding: 12px; animation: none; }</style><body>
    <section class="settings-shell-full"><nav class="settings-nav sidebar-surface"><div class="settings-nav-top"><input class="settings-search" placeholder="Search settings"></div><div class="settings-nav-scroll"><button class="settings-nav-item active">General</button><button class="settings-nav-item">Appearance</button><button class="settings-toggle on" aria-label="Enabled"><span class="settings-toggle-thumb"></span></button></div></nav></section>
    <section class="fixture-controls"><div class="composer-shell">Composer surface</div><div class="composer-dock composer-dock-docked">Transparent composer dock</div><div class="thread-scroll">Transcript scroller</div><input class="plugins-search" placeholder="Search plugins"><div class="agent-capability-search-wrap"><input class="agent-capability-search" placeholder="Search capabilities"></div><div class="overlay">Dialog scrim</div><div class="plugins-modal-backdrop">Permission veil</div></section>
    <section class="fixture-controls"><div class="composer-stack"><section class="asktool-card"><div class="asktool-card-header"><span class="asktool-card-title">Question</span></div><button class="asktool-option">Blue</button><button class="asktool-option selected">Green</button><input class="asktool-custom-input" placeholder="Other" aria-label="Other"></section></div></section>
    <section class="fixture-prose"><div class="prose-chat"><p>Answer prose with a <kbd>K</kbd> keycap and an <code>inline chip</code>.</p></div><div class="thinking-prose"><code>thinking code</code></div><div class="code-block-head">Code card head band</div><div class="mermaid-block-body">Mermaid canvas</div><button class="send-btn" disabled>Send</button></section>
    <section class="fixture-tools"><div class="tool-row-content">Tool output</div><div class="tool-block is-plain"><div class="tool-row-content">Plain tool output</div></div><div class="tool-row-content is-error">Error tool output</div></section>
    <script src="renderer.js"></script>`);
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1040, height: 640, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    window.show();
    window.focus();
    window.webContents.focus();
    // Chromium only matches :focus-visible while it believes the page owns focus.
    // This window cannot be relied on to keep macOS foreground focus across the
    // probe loop, so emulate it (three-column-layout uses the same command).
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    // Input delivery is asynchronous. Wait for the keyboard focus seed before
    // the probe blurs it; otherwise Tab can land during the first paint sample.
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => {" +
      "const target = document.querySelector('.settings-search');" +
      "if (document.activeElement === target) resolve();" +
      "else target.addEventListener('focus', () => resolve(), { once: true });" +
      "})"
    );
    const checks = [];
    for (const theme of ["light", "dark"]) {
      for (const custom of [false, true, false]) {
        const result = await window.webContents.executeJavaScript("globalThis.${probeName}(" + JSON.stringify(theme) + "," + custom + ")");
        checks.push(result);
        if (process.env.PI_E2E_ARTIFACT_DIR) {
          const fs = require("node:fs");
          fs.mkdirSync(process.env.PI_E2E_ARTIFACT_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.PI_E2E_ARTIFACT_DIR, "surfaces-" + theme + "-" + custom + ".png"), (await window.webContents.capturePage()).toPNG());
        }
      }
    }
    console.log("THEME_SURFACES_PROBE " + JSON.stringify({ ok: checks.every((check) => check.ok), checks }));
    app.quit();
  } catch (error) {
    console.error("THEME_SURFACES_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
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
  const line = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("THEME_SURFACES_PROBE "));
  assert(
    line,
    `renderer returned no probe result (exit=${code}): ${output.slice(-2000)}`,
  );
  const result = JSON.parse(line.slice("THEME_SURFACES_PROBE ".length));
  console.log("THEME_SURFACES_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
