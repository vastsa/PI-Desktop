import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { BrowserCookiesSection } from "../../apps/desktop/src/features/settings/BrowserCookiesSection";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
let status = { supported: true, profiles: [{ id: "Default", name: "Personal" }] };
const calls = [];
let pendingImport = null;
window.piDesktop = {
  on() { return () => {}; },
  async invoke(channel, input) {
    calls.push({ channel, input });
    if (channel === IPC.invoke.browserCookiesStatus) return { ok: true, data: status };
    if (channel === IPC.invoke.browserCookiesImport) return new Promise((resolve) => { pendingImport = resolve; });
    if (channel === IPC.invoke.browserCookiesClear) return { ok: true, data: undefined };
    throw new Error("Unexpected IPC: " + channel);
  },
};
const frame = () => new Promise(requestAnimationFrame);
function check(condition, message) { if (!condition) throw new Error(message + ": " + document.body.textContent); }
async function until(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate()) return;
    await frame();
  }
  check(false, message);
}
const button = (label) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
const invoked = (channel) => calls.filter((call) => call.channel === channel);

window.browserCookiesProbe = async () => {
  let rootNode = createRoot(document.getElementById("root"));
  flushSync(() => rootNode.render(React.createElement(BrowserCookiesSection)));
  await until(() => document.body.textContent.includes("Personal"), "profile not listed");
  check(invoked(IPC.invoke.browserCookiesImport).length === 0, "opening Settings imported cookies");

  const trigger = button("Import");
  flushSync(() => { trigger.click(); trigger.click(); });
  await until(() => !!button("Importing…"), "import has no busy state");
  check(button("Importing…").disabled, "busy import button is enabled");
  const imports = invoked(IPC.invoke.browserCookiesImport);
  check(imports.length === 1, "double click started two imports");
  check(JSON.stringify(imports[0].input) === JSON.stringify({ profile: "Default" }), "wrong request " + JSON.stringify(imports[0].input));
  pendingImport({ ok: true, data: { imported: 12, skipped: 3, failed: 1 } });
  await until(() => document.querySelector('[role="status"]')?.textContent.includes("Imported 12 cookies. Skipped 3, failed 1."), "result not shown");

  // Clearing needs a second, explicit confirmation.
  flushSync(() => button("Clear").click());
  check(invoked(IPC.invoke.browserCookiesClear).length === 0, "clear ran without confirmation");
  flushSync(() => button("Cancel").click());
  flushSync(() => button("Clear").click());
  flushSync(() => button("Clear cookies").click());
  await until(() => document.body.textContent.includes("Cleared all cookies"), "clear result not shown");
  check(invoked(IPC.invoke.browserCookiesClear).length === 1, "clear IPC count");

  // Keychain denial surfaces as a visible, retryable error.
  flushSync(() => button("Import").click());
  pendingImport({ ok: false, error: { code: "CHROME_KEYCHAIN_DENIED", message: "Access denied" } });
  await until(() => document.querySelector('[role="alert"]'), "import failure hidden");
  check(!button("Import").disabled, "failed import cannot be retried");
  flushSync(() => rootNode.unmount());

  status = { supported: false, profiles: [] };
  rootNode = createRoot(document.getElementById("root"));
  flushSync(() => rootNode.render(React.createElement(BrowserCookiesSection)));
  await until(() => document.body.textContent.includes("macOS only"), "unsupported reason missing");
  check(button("Import").disabled, "unsupported platform can import");
  flushSync(() => rootNode.unmount());
  return { passed: true };
};
`;

test("browser login state Settings imports only on click and confirms clearing", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "browser-cookies-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
    });
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("BROWSER_COOKIES_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.browserCookiesProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("BROWSER_COOKIES_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("BROWSER_COOKIES_PROBE ".length)), { passed: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
