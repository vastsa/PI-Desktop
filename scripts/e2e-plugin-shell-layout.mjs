#!/usr/bin/env node
/** Real isolated plugin process → Main relay → built renderer and shell UI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IPC } from "../packages/shared/dist/protocol.js";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const id = "test.shell-layout";
const scratch = await mkdtemp(join(tmpdir(), "pi-shell-layout-e2e-"));
const home = join(scratch, "home");
const dataDir = join(scratch, "data");
const pluginDir = join(scratch, "plugin");
const hostBin = resolveHostBinary();
const { appDir, electronBinary } = resolveElectronBinary(root);
assertDesktopBuild(root);
let child, cdp;
let output = "";
const failures = [];
const check = (name, condition, detail) => {
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${name}`);
};
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function connect(port, select = (target) => target.type === "page" && target.url.endsWith("/index.html")) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(select);
  if (!target) throw new Error("Electron renderer is not ready");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown") failures.push(message.params.exceptionDetails.text);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("CDP connection closed")); }
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await call("Runtime.enable");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  return { call, evaluate, close: () => socket.close() };
}
async function until(action, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await action();
    if (last) return last;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
async function invoke(channel, ...args) {
  return cdp.evaluate(`(async()=>{const r=await window.piDesktop.invoke(${JSON.stringify(channel)},...${JSON.stringify(args)});if(!r.ok)throw new Error(JSON.stringify(r.error));return r.data})()`);
}
// The existing renderer-call test transport permits 10 calls/s. Reserve
// clock-based slots below that limit; production limits remain unchanged.
let nextPluginCallAt = 0;
const plugin = async (method, input) => {
  const slot = Math.max(Date.now(), nextPluginCallAt);
  nextPluginCallAt = slot + 125;
  if (slot > Date.now()) await delay(slot - Date.now());
  return invoke(IPC.invoke.pluginRendererCall, id, method, input ?? {});
};
const eventCount = () => plugin("events").then((events) => events.length);
async function frames() { await cdp.evaluate("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))"); }
async function drag(selector, delta, mid) {
  // A background native window can consume the first press for activation.
  // Verify the real gesture starts so preview checks cannot pass vacuously.
  await cdp.call("Page.bringToFront");
  const point = await cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+Math.min(r.height/2,200)}:null})()`);
  assert.ok(point, `Missing separator ${selector}`);
  const hit = await cdp.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});const hit=document.elementFromPoint(${point.x},${point.y});return {matches:!!hit&&node.contains(hit),hit:hit?.outerHTML.slice(0,180)}})()`);
  assert.ok(hit.matches, `Separator is covered: ${JSON.stringify(hit)}`);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  const gestureAttribute = selector.includes("sidebar") ? "data-sidebar-resizing" : "data-work-panel-resizing";
  await until(() => cdp.evaluate(`document.documentElement.getAttribute(${JSON.stringify(gestureAttribute)})==='true'`), `trusted resize gesture ${selector}`);
  const startWidth = await cdp.evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))`);
  for (const ratio of [0.25, 0.5, 1]) {
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + delta * ratio, y: point.y, button: "left", buttons: 1 });
    await frames();
    await mid?.();
  }
  const previewWidth = await cdp.evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))`);
  assert.notEqual(previewWidth, startWidth, `Trusted resize moves did not change ${selector}`);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + delta, y: point.y, button: "left", clickCount: 1 });
  await until(() => cdp.evaluate(`document.documentElement.getAttribute(${JSON.stringify(gestureAttribute)})!=='true'`), `resize completion ${selector}`);
}
try {
  await mkdir(home, { recursive: true });
  await mkdir(pluginDir);
  const projectPath = join(scratch, "project");
  await mkdir(projectPath);
  const filePath = join(projectPath, "example.txt");
  await writeFile(filePath, "A real work-panel file.\n");
  await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name: "Shell layout E2E", version: "0.0.1", main: "main.js",
    renderer: "renderer.mjs", rendererActions: ["plugin.call"],
    rendererCallMethods: ["get", "sidebar", "panel", "tabs", "activate", "events", "subscribe", "unsubscribe"],
    permissions: ["ui.shell", "renderer.extension", "ui.panel"],
    ui: { panel: "panel.html", title: "Shell layout bridge", width: 480, height: 320 },
    activationEvents: ["onStartup"],
  }));
  await writeFile(join(pluginDir, "renderer.mjs"), "export function onLoad() {}\n");
  await writeFile(join(pluginDir, "panel.html"), '<!doctype html><html><body><h1>Shell layout bridge</h1><script src="panel.js"></script></body></html>');
  await writeFile(join(pluginDir, "panel.js"), `globalThis.layouts=[];globalThis.offLayout=pluginBridge.on('shell:layout',v=>layouts.push(v));`);
  await writeFile(join(pluginDir, "main.js"), `let events=[];const handler=v=>events.push(v);module.exports={onRendererCall:async(method,args)=>{switch(method){case'get':return pi.shell.getLayout();case'sidebar':return pi.shell.setSidebar(args);case'panel':return pi.shell.setWorkPanel(args);case'tabs':return pi.workPanel.listTabs();case'activate':return pi.workPanel.activateTab(args.tabId);case'events':return events;case'subscribe':events=[];pi.events.on('shell:layout',handler);return true;case'unsubscribe':pi.events.off('shell:layout',handler);return true;default:throw new Error(method)}}};`);
  const host = new Host(hostBin, dataDir);
  await host.start();
  let sessionId;
  try {
    await host.call("workspace.set", { path: projectPath });
    const created = await host.call("session.create", { title: "Shell layout E2E", mode: "agent", projectPath });
    sessionId = created.session.id;
    await host.call("plugins.loadDev", { path: pluginDir });
    await host.call("settings.set", { locale: "en" });
  } finally { await host.stop(); }
  const port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: hostBin, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, "profile")}`, "."], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output = (output + data).slice(-30_000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${output}`);
    try { cdp = await connect(port); return true; } catch { return false; }
  }, "Electron renderer");
  await until(() => cdp.evaluate("!!window.__PI_DESKTOP__ && !!document.querySelector('.app-chat-shell')"), "ready shell");
  await cdp.evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessionId)})`);
  await until(() => plugin("get").then(() => true), "plugin shell read");
  const initial = await plugin("get");
  check("live layout and pure tab reads", typeof initial.sidebar.width === "number" && !(await plugin("tabs")).tabs.length, initial);
  await plugin("subscribe");
  await until(async () => await eventCount() === 1, "initial subscriber layout");
  const collapsed = await plugin("sidebar", { collapsed: true });
  check("collapse returns applied state and retained width", collapsed.sidebar.collapsed && collapsed.sidebar.width >= 240, collapsed);
  const reopened = await plugin("sidebar", { collapsed: false, width: 100 });
  check("reopen clamps sidebar minimum", !reopened.sidebar.collapsed && reopened.sidebar.width === 240, reopened);
  const beforeNoop = await eventCount();
  await plugin("sidebar", { collapsed: false, width: 100 });
  await frames();
  check("identical setter has no duplicate event", await eventCount() === beforeNoop);
  const blank = await plugin("panel", { visible: true, width: 100 });
  check("blank panel opens without creating a tab", blank.workPanel.visible && blank.workPanel.width === 244 && blank.workPanel.tabs.length === 0, blank);
  const actualWidth = await cdp.evaluate("document.querySelector('.work-panel').getBoundingClientRect().width");
  check("API width equals rendered panel", Math.abs(actualWidth - blank.workPanel.width) <= 1, { actualWidth, api: blank.workPanel.width });
  await cdp.evaluate(`window.__PI_CAPTURE__=1;window.__PI_DESKTOP__.openWorkPanelArtifact('file',${JSON.stringify(filePath)})`);
  await cdp.evaluate("window.__PI_DESKTOP__.openWorkPanelArtifact('review')");
  const listed = await plugin("tabs");
  check("tab list follows strip order and labels", listed.tabs.length === 2 && listed.tabs[0].label === "example.txt", listed);
  const hidden = await plugin("panel", { visible: false });
  const chosen = await plugin("activate", { tabId: listed.tabs[0].id });
  check("activation retains collapsed visibility", chosen.activeTabId === listed.tabs[0].id && !(await plugin("get")).workPanel.visible, chosen);
  const unknown = await plugin("activate", { tabId: "closed:unknown" });
  check("unknown tab is a no-op", unknown.activeTabId === chosen.activeTabId);
  const restored = await plugin("panel", { visible: true });
  check("reopening retains tabs and active tab", restored.workPanel.tabs.length === hidden.workPanel.tabs.length && restored.workPanel.activeTabId === chosen.activeTabId);
  await plugin("sidebar", { collapsed: false, width: 280 });
  const startCount = await eventCount();
  await drag(".sidebar-resize-handle", 48, async () => {
    check("sidebar preview sends no event", await eventCount() === startCount);
  });
  await until(async () => await eventCount() === startCount + 1, "one final sidebar drag event");
  const afterSidebar = await plugin("get");
  check("sidebar drag final width is returned", afterSidebar.sidebar.width === 328, afterSidebar);
  const panelStart = await eventCount();
  await drag(".work-panel-resize", -48, async () => {
    check("work-panel preview sends no event", await eventCount() === panelStart);
    const layout = await plugin("get");
    const dom = await cdp.evaluate("document.querySelector('.work-panel').getBoundingClientRect().width");
    check("live read includes pointer preview width", Math.abs(layout.workPanel.width - dom) <= 1);
  });
  await until(async () => {
    const count = await eventCount();
    if (count > panelStart + 1) throw new Error(`Duplicate final work-panel events: ${count - panelStart}`);
    return count === panelStart + 1;
  }, "one final work-panel drag event");
  await invoke(IPC.invoke.pluginOpenPanel, id);
  const panelCdp = await until(async () => {
    try { return await connect(port, (target) => target.type === "page" && target.url.endsWith("panel.html")); } catch { return null; }
  }, "sandboxed plugin panel");
  try {
    await until(() => panelCdp.evaluate("globalThis.layouts?.length===1"), "panel subscriber initial replay");
    const panelRead = await panelCdp.evaluate("pluginBridge.invoke('shell.getLayout')");
    check("sandboxed panel bridge reads real layout", panelRead.workPanel.tabs.length === 2);
    await panelCdp.evaluate("offLayout()");
    await plugin("sidebar", { collapsed: true });
    check("panel unsubscribe stops delivery", await panelCdp.evaluate("layouts.length") === 1);
    await plugin("sidebar", { collapsed: false, width: 280 });
    await plugin("panel", { visible: false });
    for (const legacy of [false, true]) {
      const start = (await plugin("get")).sidebar.width;
      let queued = false;
      await drag(".sidebar-resize-handle", 16, async () => {
        if (queued) return;
        queued = true;
        const expression = legacy
          ? "pluginBridge.send('shell.setSidebar',{width:480})"
          : "void pluginBridge.invoke('shell.setSidebar',{width:480}).catch(()=>{})";
        await panelCdp.evaluate(expression);
        await panelCdp.call("Page.reload");
        await until(() => panelCdp.evaluate("document.readyState==='complete' && !!globalThis.layouts"), "plugin document reload");
      });
      const after = await plugin("get");
      check(`${legacy ? "legacy" : "async"} caller reload cancels queued mutation`, after.sidebar.width === start + 16, after.sidebar);
    }
  } finally { panelCdp.close(); }
  await plugin("unsubscribe");
  const offCount = await eventCount();
  await plugin("sidebar", { collapsed: false });
  check("process unsubscribe stops delivery", await eventCount() === offCount);
  await invoke(IPC.invoke.pluginDisable, id);
  check("no uncaught renderer errors", failures.length === 0, failures);
  console.log("PASS complete cross-process shell layout user path");
} catch (error) {
  if (cdp) {
    console.error("Layout diagnostic:", await plugin("get").catch(String));
    console.error("Event diagnostic:", await plugin("events").then((events) => events.map((v) => [v.sidebar.collapsed, v.sidebar.width, v.workPanel.visible, v.workPanel.width, v.workPanel.activeTabId])).catch(String));
  }
  if (cdp) console.error("Renderer diagnostic:", await cdp.evaluate("({url:location.href,body:document.body.innerText.slice(0,1800),api:!!window.__PI_DESKTOP__})").catch(String));
  console.error(output);
  throw error;
} finally {
  cdp?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timer);
  }
  if (process.env.E2E_KEEP_ARTIFACTS === "1") console.log(`Artifacts: ${scratch}`);
  else await rm(scratch, { recursive: true, force: true });
}
