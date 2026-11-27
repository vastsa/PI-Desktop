import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const appDir = join(root, "apps/desktop");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SystemSettings } from "./src/features/settings/pages/SystemSettings";
import { lanEn, lanZh } from "./src/locales/lan";
import "./src/styles/tokens.css";
import "./src/styles/base.css";
import "./src/styles/ui-kit.css";
import "./src/styles/settings.css";
import "./src/styles/lan-webui.css";

const admin = "pi-desktop/lan-webui/admin";
const changed = "pi-desktop/lan-webui/changed";
const listeners = new Set();
const writes = [];
const copied = [];
const view = {
  enabled: false, running: false, origin: null, address: null, port: null, code: null, devices: [], error: null,
  interfaces: [{ address: "192.168.1.20", name: "Wi-Fi" }],
};
let stateReads = 0;
let startFails = true;
let issueCount = 0;
const emit = () => { for (const listener of listeners) listener(null); };
const snapshot = (error = view.error) => ({ ok: true, data: structuredClone({ ...view, error }) });

window.piDesktop = {
  platform: "darwin",
  on(channel, listener) {
    if (channel !== changed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async invoke(channel, action) {
    if (channel !== admin) return { ok: true, data: null };
    if (action.kind === "state") {
      if (++stateReads === 1) throw new Error("Desktop temporarily unavailable");
      return snapshot();
    }
    writes.push(action);
    switch (action.kind) {
      case "start":
        if (startFails) {
          startFails = false;
          emit(); // Main can notify before the IPC reply arrives.
          return snapshot("PORT_IN_USE");
        }
        Object.assign(view, { enabled: true, running: true, address: action.address, port: action.port, origin: "http://" + action.address + ":" + action.port, error: null });
        break;
      case "issueCode":
        issueCount++;
        view.code = { value: ["000012", "034209", "512309"][issueCount - 1], expiresAt: Date.now() + (issueCount === 1 ? -1000 : 300_000) };
        break;
      case "revoke":
        view.devices = view.devices.filter((item) => item.id !== action.id);
        break;
      case "stop":
        Object.assign(view, { enabled: false, running: false, origin: null, code: null, devices: [], error: null });
        break;
      default:
        throw new Error("Unexpected LAN action: " + action.kind);
    }
    emit();
    return snapshot();
  },
};
Object.defineProperty(navigator, "clipboard", { value: { async writeText(text) { copied.push(text); } } });

await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", interpolation: { escapeValue: false },
  resources: { en: { translation: flattenCatalog(catalogs.en), lan: lanEn }, "zh-CN": { lan: lanZh } },
});
const rootNode = createRoot(document.getElementById("root"));
rootNode.render(<SystemSettings settings={{}} saveSettings={async () => {}} platform="darwin" />);

const frame = () => new Promise(requestAnimationFrame);
async function wait(fn, label) {
  for (let i = 0; i < 180; i++) {
    const value = fn();
    if (value) return value;
    await frame();
  }
  throw new Error("Timed out: " + label);
}
const check = (condition, label) => { if (!condition) throw new Error(label); };
const q = (selector, node = document) => node?.querySelector(selector);
const section = () => [...document.querySelectorAll(".settings-card-block")].find((card) => q("h3", card)?.textContent === lanEn.title);
const button = (name, node = document) => [...(node?.querySelectorAll("button") ?? [])].find((el) => el.textContent.trim() === name);
const dialog = () => q(".lan-dialog[role=dialog]");
const title = () => q("h2", dialog())?.textContent;
const toggle = () => q('[role="switch"][aria-label="Allow LAN connections"]');
const field = () => q('input[aria-label="Port"]');
const alert = () => q('[role="alert"]', section())?.textContent;
const click = (element) => { check(element && !element.disabled, "Missing or disabled control"); element.focus(); element.click(); };
const press = (key, shiftKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
const input = (value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field(), value);
  field().dispatchEvent(new Event("input", { bubbles: true }));
};
function fitsDialog() {
  const node = dialog();
  const bounds = node.getBoundingClientRect();
  const body = q(".lan-dialog-body", node);
  return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
    && body.scrollWidth <= body.clientWidth + 1 && getComputedStyle(body).overflowY === "auto";
}

window.lanSettingsProbe = async () => {
  await wait(() => button(lanEn.retry, section()), "state error and Retry");
  click(button(lanEn.retry, section()));
  await wait(() => toggle() && !toggle().disabled, "initial state");
  check(toggle().getAttribute("aria-checked") === "false" && !button(lanEn.addDevice), "service starts off");

  input("1");
  await frame();
  click(toggle());
  await wait(() => alert() === lanEn.errors.INVALID_PORT, "invalid port");
  check(field().getAttribute("aria-invalid") === "true" && writes.length === 0, "client validation before start");
  input("38180");
  await frame();
  click(toggle());
  await wait(() => alert() === lanEn.errors.PORT_IN_USE && stateReads >= 3, "start error survives a state refresh");
  click(toggle());
  await wait(() => toggle().getAttribute("aria-checked") === "true" && button(lanEn.addDevice), "listener started");
  check(!field() && !alert() && q(".lan-address-url").textContent === view.origin, "connection status shows copyable address");
  click(button(lanEn.copy));
  await wait(() => button(lanEn.copied), "clipboard feedback");

  click(button(lanEn.addDevice));
  await wait(() => title() === lanEn.pairTitle && dialog().textContent.includes(lanEn.codeExpired), "expired pairing code");
  check(fitsDialog(), "pairing fits a narrow dark window");
  check(dialog().textContent.includes(lanEn.pairDescription), "the code dialog discloses its access");
  check(!q(".lan-pair-qr") && !button(lanEn.copyCode), "expired codes cannot be copied or scanned");
  click(button(lanEn.newCode, dialog()));
  await wait(() => q(".lan-code")?.textContent === "034209" && q(".lan-pair-qr"), "replacement code and QR");
  const qr = q(".lan-pair-qr");
  const firstPath = q("path", qr)?.getAttribute("d");
  check(firstPath && qr.getAttribute("aria-label") === lanEn.pairQrLabel && fitsDialog(), "scannable code fits the dark window");
  click(button(lanEn.copyCode, dialog()));
  await wait(() => button(lanEn.copied, dialog()), "code clipboard feedback");
  await wait(() => dialog().contains(document.activeElement), "focus in pair dialog");
  press("Escape");
  await wait(() => !dialog() && document.activeElement === button(lanEn.addDevice), "Escape returns focus");
  document.documentElement.dataset.theme = "light";
  click(button(lanEn.addDevice));
  await wait(() => q(".lan-code")?.textContent === "512309", "fresh code when opened again");
  check(fitsDialog() && !dialog().querySelector('input[type="checkbox"]'), "pairing fits the light window without permission controls");
  const nextPath = q(".lan-pair-qr path")?.getAttribute("d");
  check(nextPath && nextPath !== firstPath, "the QR changes with the new code");
  q(".lan-dialog-close", dialog()).focus();
  check(!press("Tab", true) && document.activeElement === button(lanEn.newCode, dialog()), "Shift+Tab stays in the pairing dialog");
  view.devices.push({ id: "device", label: "iPhone", lastActiveAt: Date.now() });
  view.code = null;
  emit();
  await wait(() => !dialog() && q(".lan-device-name")?.textContent === "iPhone" && document.activeElement === button(lanEn.addDevice), "paired device appears directly and focus returns");
  check(q(".lan-device").querySelectorAll("button").length === 1, "a paired device can be removed, not configured");
  click(button(lanEn.remove));
  await wait(() => q(".lan-devices-empty")?.textContent === lanEn.noDevices, "device removed");

  const failRestore = () => {
    Object.assign(view, { running: false, origin: null, error: "PORT_IN_USE" });
    emit();
    return wait(() => alert() === lanEn.errors.PORT_IN_USE && q('.lan-status').textContent === lanEn.statusNotRunning, "restore error is visible");
  };
  await failRestore();
  check(toggle().getAttribute("aria-checked") === "true" && field().value === "38180", "enabled preference and port survive a failed bind");
  click(button(lanEn.retry, section()));
  await wait(() => button(lanEn.addDevice) && !alert(), "retry uses the saved binding");
  await failRestore();
  click(toggle());
  await wait(() => toggle().getAttribute("aria-checked") === "false" && !button(lanEn.addDevice), "service stopped");
  await i18n.changeLanguage("zh-CN");
  await wait(() => q('[role="switch"][aria-label="允许局域网连接"]'), "Chinese LAN settings strings");
  rootNode.unmount();
  return { writes, copied, remainingListeners: listeners.size };
};
`;

test("Desktop Settings shows a code, registers the paired device directly, and removes it", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron test requires a display" : false,
}, async (t) => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "lan-settings-ui-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await build({
    stdin: { contents: fixture, resolveDir: appDir, sourcefile: "lan-settings-ui.tsx", loader: "tsx" },
    outfile: join(temp, "fixture.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: Object.fromEntries([
      ["@pi-desktop/i18n", join(root, "packages/i18n/src")],
      ...["react", "react-dom", "i18next", "react-i18next"].map((name) => [name, join(appDir, "node_modules", name)]),
    ]),
  });
  await writeFile(join(temp, "index.html"), '<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script></html>');
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 420, height: 520,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => { if (event.level === "error") console.error(event.message); });
  try {
    await win.loadFile(join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.lanSettingsProbe()");
    console.log("LAN_SETTINGS " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error.stack ?? error); app.exit(1); }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, signal: t.signal });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, output.slice(-6000));
  const line = output.split(/\r?\n/).find((value) => value.startsWith("LAN_SETTINGS "));
  assert.ok(line, output.slice(-6000));
  assert.deepEqual(JSON.parse(line.slice("LAN_SETTINGS ".length)), {
    writes: [
      { kind: "start", address: "192.168.1.20", port: 38180 },
      { kind: "start", address: "192.168.1.20", port: 38180 },
      { kind: "issueCode" }, { kind: "issueCode" }, { kind: "issueCode" },
      { kind: "revoke", id: "device" },
      { kind: "start", address: "192.168.1.20", port: 38180 }, { kind: "stop" },
    ],
    copied: ["http://192.168.1.20:38180", "034209"],
    remainingListeners: 0,
  });
});
