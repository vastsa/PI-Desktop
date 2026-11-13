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
import { PluginSettingsSheet } from "../../apps/desktop/src/components/plugins/PluginSettingsSheet";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const writes = [];
window.piDesktop = { platform: "darwin", on() { return () => {}; },
  async invoke(channel, payload) {
    if (channel !== IPC.invoke.pluginSettingsSet) throw new Error("Unexpected IPC: " + channel);
    writes.push(structuredClone(payload.settings));
    return { ok: true, data: { settings: [] } };
  } };
const view = createRoot(document.getElementById("root"));
let key = 0;
let closed = 0;
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { await frame(); await frame(); };
function check(ok, message) { if (!ok) throw new Error(message); }
const textarea = () => document.querySelector("textarea");
async function open(value, fallback = value) {
  const plugin = { id: "fixture.json", name: "JSON fixture", settings: [
    { key: "json", title: "JSON", type: "json", value, default: fallback },
    { key: "enabled", title: "Enabled", type: "boolean", value: false },
  ] };
  flushSync(() => view.render(<PluginSettingsSheet key={++key} plugin={plugin}
    platform="darwin" onSaved={() => {}} onClose={() => { closed++; }} />));
  await settle();
}
async function save(expected) {
  const count = writes.length;
  const wasClosed = closed;
  flushSync(() => document.querySelector(".plugins-modal-actions button:last-child").click());
  await settle();
  check(writes.length === count + 1, "save failed: " + document.body.textContent);
  const actual = writes.at(-1).json;
  check(JSON.stringify(actual) === JSON.stringify(expected),
    "JSON value changed: expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
  check(closed === wasClosed + 1, "successful save did not close the sheet");
  return actual;
}
function edit(text) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
window.jsonSettingsProbe = async () => {
  for (const value of ["42", "hello", "true", "null", "", null, false, 42, ["a"], { mode: "auto" }]) {
    await open(value);
    const saved = await save(value);
    await open(saved);
    check(textarea().value === JSON.stringify(value, null, 2), "reopened editor lost JSON representation");
    await save(value);
  }
  await open("original", "true");
  edit(JSON.stringify("edited"));
  await save("edited");
  await open("edited", "true");
  flushSync(() => document.querySelector(".plugins-setting-reset").click());
  await save("true");
  await open("safe");
  edit("{broken");
  const count = writes.length;
  flushSync(() => document.querySelector(".plugins-modal-actions button:last-child").click());
  await settle();
  check(writes.length === count && document.querySelector('[role="alert"]'), "invalid JSON was not rejected");
  check(textarea().value === "{broken", "validation erased the draft");
  flushSync(() => view.unmount());
  return { passed: true, saves: writes.length };
};
`;

test("JSON settings keep their type through the real sheet save/reopen/reset path", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-plugin-json-ui-"));
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
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("JSON_SETTINGS_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.jsonSettingsProbe()")));
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
    assert.match(output, /JSON_SETTINGS_PROBE .*"passed":true,"saves":22/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
