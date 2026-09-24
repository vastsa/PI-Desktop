#!/usr/bin/env node
/** E2E-MCP-control-setting-survives-restart: real UI, host storage and HTTP. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const { appDir } = assertDesktopBuild(root);
const { electronBinary } = resolveElectronBinary(root);
const binary = resolveHostBinary();
const temp = await mkdtemp(join(tmpdir(), "pi-mcp-settings-"));
const dataDir = join(temp, "data");
const manifestPath = join(dataDir, "mcp-control.json");
const toggleSelector = '[role="switch"][aria-label="Enable MCP control at startup"]';
let child;
let exited;
let socket;
let output = "";
let sequence = 0;
const pending = new Map();

async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
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
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function manifest() {
  try { return JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function settings() {
  const result = await evaluate("window.piDesktop.invoke('pi-desktop/settings/get')");
  assert.equal(result.ok, true);
  return result.data;
}

async function seed(patch) {
  const host = new Host(binary, dataDir);
  try {
    await host.start();
    await host.call("settings.set", patch);
  } finally { await host.stop(); }
}

async function launch(control) {
  output = "";
  const env = {
    ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: binary,
    PI_DESKTOP_MCP_PORT: "0", PI_DESKTOP_CAPTURE: "1", ELECTRON_RENDERER_URL: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_DESKTOP_BOOT_PROBE;
  delete env.PI_DESKTOP_MCP_CONTROL;
  if (control !== undefined) env.PI_DESKTOP_MCP_CONTROL = control;
  child = spawn(electronBinary, ["--remote-debugging-port=0", `--user-data-dir=${join(temp, "profile")}`, "."],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  exited = new Promise((resolve) => child.once("close", resolve));
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => { output = (output + data).slice(-16_000); });
  }
  let target;
  await waitFor(async () => {
    if (spawnError) throw spawnError;
    const port = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      target = (await response.json()).find((item) => item.type === "page"
        && item.url.includes("out/renderer/index.html") && !item.url.includes("surface="));
      return !!target;
    } catch { return false; }
  }, "renderer target");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  await waitFor(() => evaluate("!!document.querySelector('.main-pane') && !document.querySelector('.startup-splash')"), "ready shell");
}

async function quit() {
  // The capture-mode profile skips the user quit dialog but runs real shutdown.
  await evaluate("void window.piDesktop.invoke('pi-desktop/app/quit')");
  let timer;
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Desktop did not quit")), 15_000);
    })]);
  } finally { clearTimeout(timer); }
  socket.close();
  socket = null;
  child = null;
  assert.notEqual((await manifest())?.active, true, "shutdown must deactivate the manifest");
}

async function openMcpSettings() {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: ",", code: "Comma", windowsVirtualKeyCode: 188,
      modifiers: process.platform === "darwin" ? 4 : 2,
    });
  }
  await waitFor(() => evaluate("!!document.querySelector('.settings-nav')"), "settings navigation");
  await evaluate("[...document.querySelectorAll('.settings-nav-item')].find(el => el.textContent.trim() === 'MCP').click()");
  await waitFor(() => evaluate(`!!document.querySelector(${JSON.stringify(toggleSelector)})`), "MCP control switch");
  assert.equal(await evaluate("!!document.querySelector('[aria-label*=\"quitting and reopening Pi\"]')"), true);
}

async function toggle(expected) {
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).getAttribute('aria-checked')`), String(!expected));
  await evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).click()`);
  await waitFor(async () => (await settings()).mcpControlEnabled === expected, "saved control preference");
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).getAttribute('aria-checked') === '${expected}'`), "updated switch");
  assert.equal((await settings()).language, "en", "unrelated settings survive");
}

async function checkEndpoint() {
  await waitFor(async () => (await manifest())?.active === true, "active MCP manifest");
  const info = await manifest();
  assert.equal(new URL(info.url).hostname, "127.0.0.1");
  const request = (authenticated) => fetch(info.url, {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${info.token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "settings-e2e", version: "1" },
    } }),
  });
  assert.equal((await request(false)).status, 401);
  const response = await request(true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.protocolVersion, "2025-06-18");
  // Never print the manifest or its bearer token, including in assertion errors.
}

try {
  await seed({ language: "en", onboardingDismissed: true });
  await launch();
  assert.notEqual((await manifest())?.active, true, "default is off");
  await openMcpSettings();
  await toggle(true);
  assert.notEqual((await manifest())?.active, true, "enabling waits for restart");
  await quit();

  await launch();
  assert.equal((await settings()).mcpControlEnabled, true);
  await checkEndpoint();
  await quit();

  // Only the historical value "1" overrides the saved preference.
  await launch("0");
  await checkEndpoint();
  await openMcpSettings();
  await toggle(false);
  await checkEndpoint();
  await quit();

  await launch();
  assert.equal((await settings()).mcpControlEnabled, false);
  assert.notEqual((await manifest())?.active, true, "disabled preference survives restart");
  await quit();

  await launch("1");
  await checkEndpoint();
  assert.equal((await settings()).mcpControlEnabled, false, "environment does not rewrite preference");
  await quit();

  await seed({ mcpControlEnabled: "true" });
  await launch();
  assert.notEqual((await manifest())?.active, true, "malformed preference fails closed");
  await quit();
  console.log("PASS E2E-MCP-control-setting-survives-restart (UI save, restart, disable, env opt-in, invalid value, authentication)");
} finally {
  socket?.close();
  if (child) { child.kill("SIGKILL"); await exited; }
  for (const { timer } of pending.values()) clearTimeout(timer);
  await rm(temp, { recursive: true, force: true });
}
