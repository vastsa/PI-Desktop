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
import { LifecycleConfirmationDialog } from "../../apps/desktop/src/components/LifecycleConfirmationDialog";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const listeners = new Map();
const responses = [];
let readyCalls = 0;
window.piDesktop = {
  platform: "darwin",
  on(channel, listener) {
    const channelListeners = listeners.get(channel) ?? new Set();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
    return () => channelListeners.delete(listener);
  },
  invoke(channel, payload) {
    if (channel.endsWith("/ready")) readyCalls += 1;
    if (channel.endsWith("/respond")) responses.push(payload);
    return Promise.resolve({ ok: true, data: channel.endsWith("/ready")
      ? { ready: true } : { accepted: true } });
  },
};
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(React.Fragment, null,
  React.createElement("button", { id: "prior-focus" }, "Previously focused"),
  React.createElement(LifecycleConfirmationDialog))));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) {
  for (let n = 0; n < 120; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message + " body=" + document.body.textContent);
}
function emit(channel, payload) {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}
function request(kind, requestId) {
  emit("pi-desktop/window/event/lifecycleDialogRequest", { requestId, kind });
}
function dismiss(requestId) {
  emit("pi-desktop/window/event/lifecycleDialogDismiss", { requestId });
}
function activeButtonName() { return document.activeElement?.textContent?.trim(); }
function clickButton(name) {
  const button = [...document.querySelectorAll('[role="dialog"] button')]
    .find((item) => item.textContent.trim() === name);
  check(button, "button not found: " + name);
  flushSync(() => button.click());
}
window.lifecycleDialogProbe = async () => {
  const prior = document.getElementById("prior-focus");
  prior.focus();
  await settle();
  check(readyCalls === 1, "renderer did not acknowledge readiness");

  request("quit-confirmation", "quit-cancel");
  await until(() => document.querySelector('[role="dialog"]'), "quit confirmation did not render");
  await settle();
  let dialog = document.querySelector('[role="dialog"]');
  check(dialog.getAttribute("aria-modal") === "true", "dialog is not modal");
  check(dialog.getAttribute("aria-labelledby") && dialog.getAttribute("aria-describedby"), "dialog lacks accessible labels");
  check(document.querySelector("h2").textContent === "Quit PI-Desktop?", "quit title is incorrect");
  check(document.querySelector("h2").textContent !== document.querySelector("p").textContent, "title and body are duplicated");
  check(activeButtonName() === "Cancel", "Cancel is not the initial focus target");
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await until(() => !document.querySelector('[role="dialog"]'), "Escape did not cancel");
  check(responses.at(-1).choice === "cancel", "Escape did not resolve as cancel");
  check(document.activeElement === prior, "focus was not restored after cancellation");

  request("quit-confirmation", "quit-confirm");
  await until(() => document.querySelector('[role="dialog"]'), "quit confirmation did not reopen");
  await settle();
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  check(activeButtonName() === "Quit", "Shift+Tab did not wrap to the final action");
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  check(activeButtonName() === "Cancel", "Tab did not wrap back to Cancel");
  clickButton("Quit");
  check(responses.at(-1).choice === "confirm", "quit action did not confirm");
  await until(() => !document.querySelector('[role="dialog"]'), "confirmed dialog stayed open");

  request("close-behavior", "close-dismiss");
  await until(() => document.querySelector('[role="dialog"]'), "timed-out dialog did not render");
  const responsesBeforeDismiss = responses.length;
  dismiss("close-dismiss");
  await until(() => !document.querySelector('[role="dialog"]'), "fallback dismissal left a stale overlay");
  check(responses.length === responsesBeforeDismiss, "main fallback dismissal was incorrectly treated as a user choice");

  request("close-behavior", "close-backdrop");
  await until(() => document.querySelector('[role="dialog"]'), "close behavior dialog did not render");
  await settle();
  dialog = document.querySelector('[role="dialog"]');
  check(document.querySelector("h2").textContent === "Keep PI-Desktop running in the background?", "close title is incorrect");
  check(dialog.querySelectorAll("button").length === 3, "close behavior does not offer all three choices");
  const overlay = document.querySelector(".lifecycle-confirmation-overlay");
  const pointer = (type) => new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
  });
  flushSync(() => {
    overlay.dispatchEvent(pointer("pointerdown"));
    overlay.dispatchEvent(pointer("pointerup"));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  check(responses.at(-1).choice === "cancel", "backdrop click did not cancel");
  await until(() => !document.querySelector('[role="dialog"]'), "backdrop left dialog open");

  request("close-behavior", "close-tray");
  await until(() => document.querySelector('[role="dialog"]'), "close behavior dialog did not reopen");
  clickButton("Close to tray");
  check(responses.at(-1).choice === "tray", "close-to-tray choice was not returned");
  await until(() => !document.querySelector('[role="dialog"]'), "tray choice left dialog open");

  request("close-behavior", "close-quit");
  await until(() => document.querySelector('[role="dialog"]'), "close behavior dialog did not reopen for quit");
  clickButton("Quit PI-Desktop");
  check(responses.at(-1).choice === "quit", "first-close Quit choice was not returned");
  await settle();
  flushSync(() => rootNode.unmount());
  return { passed: true, responses };
};
`;

test("lifecycle dialogs support accessible keyboard, backdrop, and decision paths", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-lifecycle-dialog-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
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
  const win = new BrowserWindow({ show: false, width: 720, height: 520,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("LIFECYCLE_DIALOG_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.lifecycleDialogProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("LIFECYCLE_DIALOG_PROBE "));
    assert.ok(line, output.slice(-6000));
    const result = JSON.parse(line.slice("LIFECYCLE_DIALOG_PROBE ".length));
    assert.equal(result.passed, true);
    assert.deepEqual(result.responses.map(({ requestId, choice }) => ({ requestId, choice })), [
      { requestId: "quit-cancel", choice: "cancel" },
      { requestId: "quit-confirm", choice: "confirm" },
      { requestId: "close-backdrop", choice: "cancel" },
      { requestId: "close-tray", choice: "tray" },
      { requestId: "close-quit", choice: "quit" },
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
