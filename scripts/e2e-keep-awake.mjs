#!/usr/bin/env node
// Real Electron/Host settings path with an isolated profile; no provider calls.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { waitFor } from "./e2e/wait.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-keep-awake-e2e-"));
const dataDir = join(root, "data");
const profile = join(root, "profile");
const project = join(root, "project");
const evidence = process.env.PI_KEEP_AWAKE_EVIDENCE_DIR;
const port = Number(process.env.PI_KEEP_AWAKE_CDP_PORT || 19400);
mkdirSync(dataDir);
mkdirSync(project);
const host = new Host(resolveHostBinary(), dataDir);
await host.start();
await host.call("workspace.set", { path: project });
await host.call("settings.set", { language: "en" });
await host.stop();
console.log("Keep-awake fixture Host seeded");
if (evidence) mkdirSync(evidence, { recursive: true });
const { appDir, electronBinary } = resolveElectronBinary();
let session;

function hasElectronPowerRequest() {
  if (process.platform !== "win32") return null;
  const output = execFileSync("powercfg", ["/requests"], { encoding: "utf8" });
  return /electron\.exe/i.test(output);
}

async function launch() {
  const env = {
    ...process.env,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "."],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  let target;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(output);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((entry) => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
      return !!target;
    } catch { return false; }
  }, 30_000, "desktop CDP target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  console.log("Keep-awake desktop CDP target ready");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 10_000);
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  await send("Page.enable");
  return { child, ws, send, evaluate, output: () => output };
}

async function close() {
  if (!session) return;
  session.ws.close();
  session.child.kill();
  if (session.child.exitCode === null) {
    await Promise.race([once(session.child, "exit"), delay(5_000)]);
  }
  session = null;
}

async function click(selector) {
  let point;
  await waitFor(async () => {
    point = await session.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return null;
      el.scrollIntoView({ block: 'nearest' });
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
    return !!point;
  }, 10_000, `clickable ${selector}`);
  assert.ok(point, `clickable ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
}

async function openSettings() {
  try {
    await waitFor(() => session.evaluate(`!!document.querySelector('[data-nav="settings"]')`), 15_000, "settings navigation");
    await waitFor(() => session.evaluate(`!document.querySelector('.startup-splash')`), 20_000, "startup splash exit");
  } catch (error) {
    await screenshot("keep-awake-navigation-failure.png").catch((captureError) => {
      console.error("navigation failure screenshot unavailable", captureError);
    });
    const state = await session.evaluate(`({ title: document.title, body: document.body.innerText.slice(0, 1500), nav: [...document.querySelectorAll('[data-nav]')].map(el => el.dataset.nav) })`);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  await click('[data-nav="settings"]');
  try {
    await waitFor(() => session.evaluate(`!!document.querySelector('button[aria-label="Keep computer awake"]')`), 10_000, "power setting");
  } catch (error) {
    await screenshot("keep-awake-setting-failure.png");
    const state = await session.evaluate(`({ body: document.body.innerText.slice(0, 1500), switches: [...document.querySelectorAll('[role="switch"]')].map(el => el.getAttribute('aria-label')) })`);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  console.log("Keep-awake Settings page ready");
}

async function setting() {
  return session.evaluate(`(async () => {
    const r = await window.piDesktop.invoke(window.piDesktop.channels.invoke.settingsGet);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.data.keepAwakeWhileRunning;
  })()`);
}

async function screenSetting() {
  return session.evaluate(`(async () => {
    const r = await window.piDesktop.invoke(window.piDesktop.channels.invoke.settingsGet);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.data.preventScreenSleep === true;
  })()`);
}

async function screenshot(name) {
  if (!evidence) return;
  const result = await session.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidence, name), Buffer.from(result.data, "base64"));
}

async function centerPowerControls() {
  await session.evaluate(`document.querySelector('button[aria-label="Keep computer awake"]')
    ?.closest('.settings-card-block')?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
}

const toggle = 'button[aria-label="Keep computer awake"]';
const screenToggle = 'button[aria-label="Prevent screen sleep"]';
try {
  session = await launch();
  await openSettings();
  assert.equal(await setting(), false);
  await centerPowerControls();
  await screenshot("keep-awake-off.png");
  const baselineRequest = hasElectronPowerRequest();
  await click(toggle);
  await waitFor(async () => (await setting()) === true, 5000, "enabled setting persists");
  await centerPowerControls();
  await screenshot("keep-awake-on.png");
  if (baselineRequest === false) {
    await waitFor(() => hasElectronPowerRequest() === true, 5000, "Windows Electron power request");
  }
  await click(screenToggle);
  await waitFor(async () => (await screenSetting()) === true, 5000, "display blocker enabled independently");
  assert.equal(await setting(), true);
  await click(screenToggle);
  await waitFor(async () => (await screenSetting()) === false, 5000, "display blocker disabled independently");
  assert.equal(await setting(), true);
  if (baselineRequest === false) assert.equal(hasElectronPowerRequest(), true);
  await close();

  session = await launch();
  await openSettings();
  assert.equal(await setting(), true);
  assert.equal(await session.evaluate(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-checked')`), "true");
  if (baselineRequest === false) {
    await waitFor(() => hasElectronPowerRequest() === true, 5000, "restored Windows power request");
  }
  await click(toggle);
  await waitFor(async () => (await setting()) === false, 5000, "disabled setting persists");
  if (baselineRequest === false) {
    await waitFor(() => hasElectronPowerRequest() === false, 5000, "released Windows power request");
  }
  console.log(`PASS keep-awake desktop setting: immediate enable, independent display toggle, persisted restart, disable, Windows power request ${baselineRequest === false ? "verified" : "not isolated"}`);
  console.log(`Evidence: ${evidence ?? "not requested"}; isolated profile: ${root}`);
} catch (error) {
  console.error(session?.output() ?? "");
  throw error;
} finally {
  await close();
}
