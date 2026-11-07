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
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ComputerUseSettings } from "../../apps/desktop/src/features/settings/computer-use/ComputerUseSettings";

await i18n.init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const initial = { platform: "darwin", backend: "macos-ax", fidelity: "full",
  accessibility: "not-requested", capture: "not-requested" };
let capabilities = { ...initial };
let holdRead = false;
let reads = [];
let requests = [];
let requestCount = 0;
let readCount = 0;
const permissionTimers = new Map();
const nativeSetInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
let timerId = -1;
window.setInterval = (callback, delay, ...args) => {
  if (delay !== 1000) return nativeSetInterval(callback, delay, ...args);
  const id = timerId--;
  permissionTimers.set(id, callback);
  return id;
};
window.clearInterval = (id) => {
  if (!permissionTimers.delete(id)) nativeClearInterval(id);
};
Object.defineProperty(document, "hidden", { configurable: true, value: false });
window.piDesktop = {
  on() { return () => {}; },
  async invoke(channel) {
    if (channel === IPC.invoke.computerCapabilities) {
      readCount += 1;
      if (holdRead) return new Promise((resolve) => reads.push(resolve));
      return { ok: true, data: { ...capabilities } };
    }
    if (channel === IPC.invoke.computerRequestPermission) {
      requestCount += 1;
      return new Promise((resolve) => requests.push(resolve));
    }
    throw new Error("Unexpected IPC: " + channel);
  },
};
const rootNode = createRoot(document.getElementById("root"));
const render = () => flushSync(() => rootNode.render(React.createElement(ComputerUseSettings, {
  t: i18n.t.bind(i18n), settings: { computerUse: { enabled: false } },
  saveSettings() { throw new Error("Requesting permission must not enable computer use or create a grant"); },
})));
// These checks await React state, not paint. Hidden windows can throttle rAF.
const frame = () => new Promise(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close(); channel.port2.close(); resolve();
  };
  channel.port2.postMessage(null);
});
const settle = async () => { await frame(); await frame(); };
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message + ": " + document.body.textContent);
}
const button = () => [...document.querySelectorAll("button")]
  .find((node) => /Accessibility not requested|Accessibility denied/.test(node.textContent));
const message = () => document.querySelector('[role="status"]');
function reply(data = capabilities) { requests.shift()({ ok: true, data: { ...data } }); }

window.computerPermissionProbe = async () => {
  render();
  await until(() => document.body.textContent.includes("Accessibility not requested"), "status missing");
  check(requestCount === 0, "opening Settings requested OS permission");
  check(button(), "missing Accessibility status must be a clickable button");
  button().focus();
  check(document.activeElement === button(), "request button is not keyboard focusable");
  const trigger = button();
  flushSync(() => { trigger.click(); trigger.click(); });
  await settle();
  check(requestCount === 1, "duplicate clicks launched duplicate requests");
  check(document.querySelector('button[aria-busy="true"]')?.disabled, "pending request has no disabled busy feedback");
  capabilities.accessibility = "not-requested";
  reply();
  await until(() => !!button() && !button().disabled, "request button did not recover");
  check(message()?.textContent.includes("System Settings"), "still-missing permission has no manual-grant guidance");
  await until(() => permissionTimers.size === 1, "permission follow-up timer missing");
  capabilities.applicationAccessibility = "granted";
  const beforePoll = readCount;
  [...permissionTimers.values()][0]();
  await until(() => document.body.textContent.includes("Accessibility granted"), "app grant did not update without a focus event");
  check(readCount > beforePoll && !button(), "authorized app remained actionable");
  check(message()?.textContent.includes("backend"), "backend denial was hidden behind the app grant");
  await until(() => permissionTimers.size === 0, "granted app kept polling");
  capabilities.accessibility = "granted";
  window.dispatchEvent(new Event("focus"));
  await until(() => !message(), "backend recovery did not clear the diagnostic");
  delete capabilities.applicationAccessibility;

  capabilities.accessibility = "denied";
  window.dispatchEvent(new Event("focus"));
  await until(() => !!button(), "denied permission cannot be requested again");
  flushSync(() => button().click());
  requests.shift()({ ok: false, error: { code: "HOST_UNAVAILABLE", message: "Fixture host stopped" } });
  await until(() => message()?.textContent.includes("HOST_UNAVAILABLE"), "request failure is not visible");
  check(!button().disabled, "failed request cannot be retried");
  flushSync(() => button().click());
  reply({ ...capabilities, accessibility: "granted" });
  await until(() => document.body.textContent.includes("Accessibility granted"), "retry did not update status");

  // A capabilities read started before a request must not overwrite its result.
  capabilities = { ...initial };
  window.dispatchEvent(new Event("focus"));
  await until(() => !!button(), "reset did not refresh");
  holdRead = true;
  window.dispatchEvent(new Event("focus"));
  await until(() => reads.length === 1, "controlled read did not start");
  flushSync(() => button().click());
  reply({ ...initial, accessibility: "granted" });
  await until(() => document.body.textContent.includes("Accessibility granted"), "grant result missing");
  reads.shift()({ ok: true, data: { ...initial } });
  await settle();
  check(!button(), "stale read overwrote granted permission");
  holdRead = false;

  // Returning while the request is still pending queues a fresh check.
  capabilities = { ...initial };
  window.dispatchEvent(new Event("focus"));
  await until(() => !!button(), "pending-focus reset missing");
  flushSync(() => button().click());
  capabilities.accessibility = "granted";
  window.dispatchEvent(new Event("focus"));
  reply(initial);
  await until(() => document.body.textContent.includes("Accessibility granted"), "focus during request lost the final grant");

  capabilities = { ...initial, platform: "linux", backend: "unsupported", accessibility: "unsupported" };
  window.dispatchEvent(new Event("focus"));
  await until(() => document.body.textContent.includes("Accessibility unsupported"), "unsupported status missing");
  check(!button(), "unsupported platform offers an OS request");

  // Unmount removes refresh listeners and discards pending request results.
  capabilities = { ...initial };
  window.dispatchEvent(new Event("focus"));
  await until(() => !!button(), "unmount reset missing");
  flushSync(() => button().click());
  reply();
  await until(() => permissionTimers.size === 1, "bounded polling did not start");
  for (let tick = 0; tick < 60; tick += 1) {
    [...permissionTimers.values()][0]();
    await settle();
  }
  check(permissionTimers.size === 0, "polling did not expire after 60 ticks");
  flushSync(() => button().click());
  flushSync(() => rootNode.unmount());
  const afterUnmount = readCount;
  window.dispatchEvent(new Event("focus"));
  reply();
  check(permissionTimers.size === 0, "unmounted settings retained a poll timer");
  await settle();
  check(readCount === afterUnmount, "unmounted settings retained focus listeners");
  return { passed: true, requestCount };
};
`;

test("computer-use Settings explicitly requests permission, refreshes, retries and cleans up", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "computer-permission-ui-"));
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
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("COMPUTER_PERMISSION_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.computerPermissionProbe()")));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("COMPUTER_PERMISSION_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("COMPUTER_PERMISSION_PROBE ".length)), { passed: true, requestCount: 7 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
