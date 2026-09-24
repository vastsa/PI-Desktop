#!/usr/bin/env node
/** Window controls must remain hit-testable through the real work-panel flow.
 * Uses a throwaway profile, production preload/IPC and the built application.
 * Platform CSS emulation is explicitly not native macOS/Linux qualification.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const { appDir } = assertDesktopBuild(root);
const { electronBinary } = resolveElectronBinary(root);
const binary = resolveHostBinary();
const temp = await mkdtemp(join(tmpdir(), "pi-window-controls-"));
const port = Number(process.env.PI_DESKTOP_CHROME_CDP_PORT || 9347);
const pending = new Map();
let sequence = 0;
let socket;
let child;
let output = "";
let failed = false;

async function waitFor(predicate, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function settle() {
  await evaluate(`(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => {})));
    await new Promise(requestAnimationFrame);
  })()`);
}
async function click(selector, waitForPaint = true) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing target: ' + ${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!el.contains(document.elementFromPoint(x, y))) throw new Error('Obscured target: ' + ${JSON.stringify(selector)} + ' by ' + document.elementFromPoint(x, y)?.className);
    return { x, y };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
  if (waitForPaint) await settle();
}
async function checkControls(label) {
  const result = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.window-control-btn')];
    const band = document.querySelector('.window-controls');
    const header = document.querySelector('.work-panel-header');
    if (band && header && getComputedStyle(band).backgroundColor !== getComputedStyle(header).backgroundColor)
      throw new Error('Window-control background differs from the adjacent panel header');
    return buttons.map(el => {
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { label: el.getAttribute('aria-label'), visible: r.width > 0 && r.height > 0 &&
        x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
        reachable: el.contains(document.elementFromPoint(x, y)) };
    });
  })()`);
  const ok = process.platform === "darwin"
    ? result.length === 0
    : result.length === 3 && result.every(r => r.visible && r.reachable);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(result)}`);
  if ((!ok || label === "panel opened") && process.env.PI_DESKTOP_CHROME_ARTIFACT_DIR) {
    const dir = resolve(process.env.PI_DESKTOP_CHROME_ARTIFACT_DIR);
    await mkdir(dir, { recursive: true });
    const shot = await send("Page.captureScreenshot");
    await writeFile(join(dir, ok ? "window-controls-fixed.png" : "window-controls-failure.png"), Buffer.from(shot.data, "base64"));
  }
  assert.ok(ok, label);
}

try {
  const host = new Host(binary, join(temp, "data"));
  let sessionId;
  try {
    await host.start();
    await host.call("workspace.set", { path: temp });
    const { session } = await host.call("session.create", { title: "Window controls regression" });
    sessionId = session.id;
  } finally {
    await host.stop();
  }
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: join(temp, "data"),
    PI_DESKTOP_HOST_BIN: binary, PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(temp, "profile")}`, "."],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { output = (output + data).slice(-4000); });
  child.stderr.on("data", data => { output = (output + data).slice(-4000); });
  let target;
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      target = (await response.json()).find(t => t.type === "page" && t.url.includes("out/renderer/index.html") && !t.url.includes("surface="));
      return !!target;
    } catch { return false; }
  }, "renderer target");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  await waitFor(() => evaluate(`!!document.querySelector('.main-pane') && !document.querySelector('.startup-splash')`), "ready shell");
  await evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessionId)})`);
  await waitFor(() => evaluate(`document.querySelector('.app-work-panel-toggle')?.disabled === false`), "active session");
  await settle();
  await checkControls("panel closed");
  await click(".app-work-panel-toggle");
  await waitFor(() => evaluate(`!!document.querySelector('.work-panel')`), "panel opened");
  await settle();
  await checkControls("panel opened");
  if (process.platform !== "darwin") {
    for (const platform of ["win32", "linux"]) {
      for (const theme of ["light", "dark"]) {
        await evaluate(`document.documentElement.dataset.platform = ${JSON.stringify(platform)};
          window.__PI_DESKTOP__.setThemeAttr(${JSON.stringify(theme)})`);
        await settle();
        await checkControls(`${platform}/${theme} CSS with panel open (emulated)`);
      }
    }
    await evaluate(`document.documentElement.dataset.platform = ${JSON.stringify(process.platform)}`);
  }
  await click('[data-nav="toggle-sidebar"]');
  await checkControls("sidebar toggled with panel open");
  await click(".work-panel-maximize");
  await waitFor(() => evaluate(`!!document.querySelector('.work-panel-maximized')`), "panel maximized");
  await checkControls("panel maximized");
  await click('[data-nav="toggle-sidebar"]');
  await checkControls("sidebar toggled with panel maximized");
  await click(".work-panel-maximize");
  await checkControls("panel restored");
  await evaluate(`window.piDesktop.invoke('pi-desktop/menu/nativeAction', {action:'toggleFullScreen'})`);
  await waitFor(() => evaluate(`window.piDesktop.invoke('pi-desktop/menu/nativeAction', {action:'restoreMainWindow'}).then(s => s.ok && s.data.fullScreen)`), "native fullscreen");
  await settle();
  await checkControls("native fullscreen with panel open");
  await evaluate(`window.piDesktop.invoke('pi-desktop/menu/nativeAction', {action:'toggleFullScreen'})`);
  await waitFor(() => evaluate(`window.piDesktop.invoke('pi-desktop/menu/nativeAction', {action:'restoreMainWindow'}).then(s => s.ok && !s.data.fullScreen)`), "leave native fullscreen");
  await settle();
  if (process.platform !== "darwin") {
    await click(".window-control-btn:nth-child(2)");
    await waitFor(() => evaluate(`window.piDesktop.invoke('pi-desktop/window/control', {action:'getState'}).then(s => s.ok && s.data.maximized)`), "native window maximized");
    await checkControls("native window maximized with panel open");
    await click(".window-control-btn:nth-child(2)");
    await waitFor(() => evaluate(`window.piDesktop.invoke('pi-desktop/window/control', {action:'getState'}).then(s => s.ok && !s.data.maximized)`), "native window restored");
  }
  await click(".app-work-panel-toggle");
  await waitFor(() => evaluate(`!document.querySelector('.work-panel')`), "panel closed again");
  await checkControls("panel closed again");
  await evaluate(`window.__PI_DESKTOP__.setPage('settings')`);
  await waitFor(() => evaluate(`!!document.querySelector('.settings-mode')`), "settings opened");
  await settle();
  await checkControls("settings route");
  await evaluate(`window.__PI_DESKTOP__.setPage('chat')`);
  await settle();
  await click(".app-work-panel-toggle");
  await settle();
  await checkControls("panel reopened after settings");
  if (process.platform !== "darwin") {
    await click(".window-control-btn:first-child", false);
    await waitFor(() => evaluate(`document.visibilityState === 'hidden'`), "native minimize");
    await evaluate(`window.piDesktop.invoke('pi-desktop/menu/nativeAction', {action:'toggleMainWindow'})`);
    await waitFor(() => evaluate(`document.visibilityState === 'visible'`), "native window shown");
    await settle();
    await checkControls("restored after native minimize");
    // Configure only the disposable profile so close-to-tray can be observed
    // without leaving a blocking native confirmation dialog on the test runner.
    await evaluate(`window.piDesktop.invoke('pi-desktop/window/closeBehavior/set', {behavior:'tray'})`);
    await click(".window-control-close", false);
    await waitFor(() => evaluate(`document.visibilityState === 'hidden'`), "native close-to-tray");
    console.log("PASS native minimize and close actions");
  }
  console.log(`PASS native ${process.platform} window-control flow`);
} catch (error) {
  failed = true;
  console.error(error);
  console.error(output);
} finally {
  socket?.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    // macOS can keep the Electron app process alive after SIGTERM while the
    // test window owns native resources. The profile is fixture-owned, so
    // force cleanup after the assertions finish or time out.
    child.kill(process.platform === "darwin" ? "SIGKILL" : "SIGTERM");
    await exited;
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exitCode = failed ? 1 : 0;
