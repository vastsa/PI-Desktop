import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
let electron;
try { electron = resolveElectronBinary(root).electronBinary; } catch { /* Reported as a skip below. */ }

test("AI settings wires the configurable native provider retry rows", async () => {
  const page = await readFile(join(root, "apps/desktop/src/features/settings/SettingsPage.tsx"), "utf8");
  assert.match(page, /<ProviderRetrySettingsRows\s+settings=\{settings\}\s+saveSettings=\{saveSettings\}/);
});

// Real rows, renderer API, i18n, UI primitives and toast store; only preload
// persistence is external. No running app, real profile or provider is used.
const fixture = String.raw`
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ProviderRetrySettingsRows } from "../../apps/desktop/src/features/settings/provider-retry-settings";
import { api } from "../../apps/desktop/src/lib/api";
import { searchSettings } from "../../apps/desktop/src/lib/settings-search";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/settings.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const fields = ["providerRetryMaxAttempts", "providerRetryInitialDelayMs", "providerRetryFixedDelayMs"];
const saved = [];
let failNext = false;
const readStored = () => JSON.parse(localStorage.getItem("retry-settings") || '{"defaultMode":"agent","theme":"light"}');
window.piDesktop = { platform: "win32", on() { return () => {}; }, async invoke(channel, payload) {
  if (channel === IPC.invoke.settingsGet) return { ok: true, data: readStored() };
  if (channel !== IPC.invoke.settingsSet) throw new Error("Unexpected fixture IPC: " + channel);
  if (failNext) { failNext = false; return { ok: false, error: { message: "fixture storage rejected", code: "TEST" } }; }
  saved.push(structuredClone(payload));
  const next = { ...readStored(), ...payload };
  for (const field of fields) if (next[field] === null) delete next[field];
  localStorage.setItem("retry-settings", JSON.stringify(next));
  return { ok: true };
} };
function Surface({ initial }) {
  const [settings, setSettings] = React.useState(initial);
  const saveSettings = async (patch) => {
    const next = { ...settings, ...patch };
    await api.setSettings(next);
    setSettings(next);
  };
  return React.createElement(ProviderRetrySettingsRows, { settings, saveSettings });
}
const rootNode = createRoot(document.getElementById("root"));
// React act drains pending updates/effects without hidden-window animation
// frames, which Windows may suspend even with backgroundThrottling disabled.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
async function settle() { await act(async () => {}); }
let revision = 0;
async function reload() {
  const initial = await api.getSettings();
  await act(async () => rootNode.render(React.createElement(Surface, { initial, key: ++revision })));
  await settle();
}
function check(condition, message) { if (!condition) throw new Error(message); }
const inputFor = (field) => document.querySelector('input[aria-label="' + i18n.t("settings." + field) + '"]');
const toast = () => useAppStore.getState().toasts.at(-1);
const clearToasts = () => useAppStore.setState({ toasts: [] });
function draft(input, text) {
  input.focus();
  check(document.activeElement === input, "input did not focus");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function commit(input, text, enter = false) {
  draft(input, text);
  await settle();
  await act(async () => enter
    ? input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    : input.blur());
  await settle();
}
window.retryProbe = async () => {
  for (const [language, catalog] of Object.entries(catalogs)) {
    const messages = flattenCatalog(catalog);
    for (const key of [...fields.flatMap((field) => [field, field + "Desc"]), "providerRetryInvalidValue", "providerRetrySaveError"]) {
      check(typeof messages["settings." + key] === "string" && messages["settings." + key].length > 0, language + " missing retry translation: " + key);
    }
    for (const field of fields) {
      const key = "settings." + field;
      const hits = searchSettings(messages[key], (item) => messages[item] || item);
      check(hits.some((hit) => hit.tab === "ai" && hit.rowKey === key), language + " retry search did not reach AI settings: " + field);
    }
  }
  await reload();
  for (const field of fields) check(inputFor(field)?.value === "", "unset input not empty: " + field);
  check(inputFor(fields[0]).placeholder === "10", "released count placeholder changed");
  check(inputFor(fields[1]).placeholder === "", "first wait has misleading single default");
  await commit(inputFor(fields[1]), "");
  check(saved.length === 0, "unset blank saved a new default");
  draft(inputFor(fields[0]), "3");
  check(saved.length === 0, "partial draft saved before commit");
  await commit(inputFor(fields[0]), "3");
  await commit(inputFor(fields[1]), "25", true);
  await commit(inputFor(fields[2]), "45000");
  check(saved.length === 3, "blur/Enter did not each save once");
  await reload();
  for (const [index, value] of ["3", "25", "45000"].entries()) {
    check(inputFor(fields[index]).value === value, "saved override lost after reload");
  }
  for (const field of fields) {
    await commit(inputFor(field), "9007199254740991");
    check(readStored()[field] === Number.MAX_SAFE_INTEGER, "safe integer ceiling rejected");
    await commit(inputFor(field), "0");
    check(readStored()[field] === 0 && inputFor(field).value === "0", "valid zero lost");
    for (const invalid of ["-5", "1.5", "9007199254740992"]) {
      clearToasts();
      const before = saved.length;
      await commit(inputFor(field), invalid);
      check(saved.length === before && inputFor(field).value === "0", "invalid number saved or not reverted");
      check(toast()?.variant === "error" && toast()?.message === i18n.t("settings.providerRetryInvalidValue"), "missing validation toast: " + JSON.stringify({ field, invalid, toast: toast(), expected: i18n.t("settings.providerRetryInvalidValue") }));
    }
  }
  // Native number input sanitization is not an intentional reset.
  const delay = inputFor(fields[1]);
  const beforeBad = saved.length;
  clearToasts();
  delay.focus(); delay.select();
  act(() => document.execCommand("insertText", false, "e"));
  check(delay.value === "" && delay.validity.badInput, "native badInput was not produced");
  await act(async () => delay.blur());
  await settle();
  check(saved.length === beforeBad && delay.value === "0", "native badInput cleared a saved value");
  check(toast()?.message === i18n.t("settings.providerRetryInvalidValue"), "missing badInput toast");
  await reload();
  for (const field of fields) check(inputFor(field).value === "0", "zero lost after reload");
  for (const field of fields) {
    await commit(inputFor(field), "", true);
    check(saved.at(-1)[field] === null && !Object.hasOwn(readStored(), field), "reset did not persist absence");
  }
  await reload();
  for (const field of fields) check(inputFor(field).value === "", "reset lost after reload");
  const beforeBlank = saved.length;
  for (const field of fields) await commit(inputFor(field), "");
  check(saved.length === beforeBlank, "already-empty rows wrote again");
  clearToasts(); failNext = true;
  await commit(inputFor(fields[0]), "4");
  check(inputFor(fields[0]).value === "" && saved.length === beforeBlank, "rejected write stayed visible");
  check(toast()?.variant === "error" && toast()?.message === i18n.t("settings.providerRetrySaveError"), "missing save-error toast");
  const toggle = document.querySelector('button[role="switch"]');
  check(toggle?.getAttribute("aria-label") === i18n.t("settings.infiniteProviderRetry"), "released switch missing");
  for (const expected of [true, false]) {
    await act(async () => toggle.click()); await settle();
    check(readStored().infiniteProviderRetry === expected, "toggle did not persist");
    check(toggle.getAttribute("aria-checked") === String(expected), "toggle did not reflect stored value");
  }
  await reload();
  check(document.querySelector('button[role="switch"]').getAttribute("aria-checked") === "false", "toggle reload failed");
  act(() => rootNode.unmount());
  return { passed: true, writes: saved.length };
};
`;

test("retry settings user path saves, reloads, resets and rejects invalid input", {
  skip: !electron ? "Electron binary is not installed" : process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-provider-retry-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      define: { "process.env.NODE_ENV": '"development"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
console.log("retry fixture starting");
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  console.log("retry fixture ready");
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.log("renderer: " + event.message));
  win.webContents.on("render-process-gone", (_event, details) => console.error("renderer exited: " + JSON.stringify(details)));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("retry fixture loaded");
    win.webContents.focus();
    console.log("RETRY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.retryProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output = (output + chunk).slice(-16_000); });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    const line = output.split(/\r?\n/).find((value) => value.startsWith("RETRY_PROBE "));
    assert.ok(line, output);
    assert.deepEqual(JSON.parse(line.slice("RETRY_PROBE ".length)), { passed: true, writes: 14 });
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
