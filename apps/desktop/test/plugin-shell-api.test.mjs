import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
const layout = { sidebar: { collapsed: false, width: 240, minWidth: 180, maxWidth: 400 }, workPanel: { visible: false, width: 320, minWidth: 244, tabs: [{ id: "f", kind: "file", label: "f" }], activeTabId: "f" } };
function spawnProcess({ entry }) { const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); return { postMessage: (message) => child.send(message), onMessage: (handler) => child.on("message", handler), onExit: (handler) => child.on("exit", handler), kill: () => child.kill() }; }
async function setup(t, permissions = ["ui.shell"], services = {}, pluginBody = "") {
  const calls = [], toasts = [], audits = [];
  const runtime = new PluginRuntime({ hostEntry, spawnProcess, getLocale: () => "en", showToast: (message) => toasts.push(message), audit: (entry) => audits.push(entry), isPluginActiveInProject: () => true, shellLayout: async (pluginId, command) => { calls.push({ pluginId, command }); return structuredClone(layout); }, ...services });
  const dir = mkdtempSync(join(tmpdir(), "pi-shell-api-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "test.shell", name: "Shell", version: "0.0.1", main: "main.js", permissions }));
  writeFileSync(join(dir, "main.js"), `module.exports={onLoad:async()=>{ ${pluginBody} }};`);
  t.after(async () => { for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id); rmSync(dir, { recursive: true, force: true }); });
  await runtime.loadFromPath(dir);
  return { runtime, calls, toasts, audits };
}
test("all shell APIs cross the actual plugin process and panel bridge", async (t) => {
  const { runtime, calls, toasts } = await setup(t, undefined, {}, `await pi.shell.getLayout(); await pi.shell.setSidebar({collapsed:true}); await pi.shell.setWorkPanel({width:500}); await pi.workPanel.listTabs(); await pi.ui.showToast(JSON.stringify(await pi.workPanel.activateTab('f')));`);
  assert.equal(calls.length, 5);
  assert.deepEqual(JSON.parse(toasts[0]), { tabs: layout.workPanel.tabs, activeTabId: "f" });
  assert.deepEqual(await runtime.invokePanelBridge("test.shell", "shell.getLayout"), layout);
  assert.deepEqual(await runtime.invokePanelBridge("test.shell", "workPanel.listTabs"), { tabs: layout.workPanel.tabs, activeTabId: "f" });
  await runtime.invokePanelBridge("test.shell", "shell.setSidebar", { width: 280 });
  await runtime.invokePanelBridge("test.shell", "shell.setWorkPanel", { visible: true });
  await runtime.invokePanelBridge("test.shell", "workPanel.activateTab", { tabId: "f" });
  assert.equal(calls.length, 10);
});
test("reads require no grant while every mutation requires ui.shell", async (t) => {
  const { runtime, calls, toasts } = await setup(t, [], {}, `await pi.shell.getLayout(); await pi.workPanel.listTabs(); for(const run of [()=>pi.shell.setSidebar({}),()=>pi.shell.setWorkPanel({}),()=>pi.workPanel.activateTab('f')]){try{await run()}catch(e){await pi.ui.showToast(e.code)}}`);
  assert.deepEqual(toasts, ["PERMISSION_DENIED", "PERMISSION_DENIED", "PERMISSION_DENIED"]);
  for (const channel of ["shell.setSidebar", "shell.setWorkPanel", "workPanel.activateTab"]) await assert.rejects(runtime.invokePanelBridge("test.shell", channel, {}), { code: "PERMISSION_DENIED" });
  assert.equal(calls.length, 2);
});
test("untrusted arguments and out-of-project reads are rejected before relay", async (t) => {
  const { runtime, calls } = await setup(t);
  for (const payload of [null, [], { width: NaN }, { width: Infinity }, { collapsed: "yes" }]) await assert.rejects(runtime.invokePanelBridge("test.shell", "shell.setSidebar", payload), { code: "INVALID_ARGUMENT" });
  await assert.rejects(runtime.invokePanelBridge("test.shell", "workPanel.activateTab", { tabId: 4 }), { code: "INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
  const scoped = await setup(t, [], { isPluginActiveInProject: () => false });
  await assert.rejects(scoped.runtime.invokePanelBridge("test.shell", "shell.getLayout"), { code: "PERMISSION_DENIED" });
});
test("each event subscriber gets ordered initial replay and off prevents delivery", async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const { runtime, toasts } = await setup(t, [], { shellLayout: async () => { await gate; return layout; } }, `const a=(v)=>pi.ui.showToast('a:'+v.sidebar.width); const b=(v)=>pi.ui.showToast('b:'+v.sidebar.width); pi.events.on('shell:layout',a); pi.events.on('shell:layout',b); pi.events.off('shell:layout',b);`);
  runtime.broadcastEvent("shell:layout", [{ ...layout, sidebar: { ...layout.sidebar, width: 300 } }]);
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(toasts, ["a:300"]);
});
test("each new shell subscriber gets a live initial layout", async (t) => {
  const { calls, toasts } = await setup(t, [], {}, `pi.events.on('shell:layout',(v)=>pi.ui.showToast('first:'+v.sidebar.width)); pi.events.on('shell:layout',(v)=>pi.ui.showToast('second:'+v.sidebar.width));`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(toasts.sort(), ["first:240", "second:240"]);
  assert.equal(calls.length, 2);
});
test("plugin disposal cancels shell requests before awaiting child unload hooks", async (t) => {
  const cleared = [];
  const { runtime } = await setup(t, [], { clearShellLayout: (id) => cleared.push(id) });
  await runtime.unload("test.shell");
  assert.deepEqual(cleared, ["test.shell"]);
});
