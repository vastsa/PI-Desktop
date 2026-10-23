#!/usr/bin/env node
/** Actual plugin/view + Desktop broker + loopback RACP + Host filesystem. No model or user profile. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = resolve(process.argv[2] || join(root, "apps/desktop/resources/plugins/pi.file-manager"));
console.log("REMOTE_FILE_MANAGER_PLUGIN " + JSON.stringify({ pluginDir }));
const qa = createRequire(join(process.env.PI_FILE_MANAGER_QA_DIR || join(pluginDir, "tests/electron"), "package.json"));
const { _electron } = qa("playwright");
const temp = await mkdtemp(join(tmpdir(), "pi-remote-manager-e2e-"));
process.env.PI_DESKTOP_DATA_DIR = join(temp, "desktop-data");
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../apps/desktop/electron/main/plugin-runtime.ts");
const { createPluginWorkspaceReader } = await import("../apps/desktop/electron/main/remote/plugin-workspace-files.ts");
const { createRacpRemoteHostClient } = await import("../apps/desktop/electron/main/remote/racp-remote-host-client.ts");
const { pluginWorkspaceInfo, rememberProjectGroups } = await import("../apps/desktop/electron/main/workspace-roots.ts");
const { createWorkspacePluginFiles } = await import("../apps/pi-host/src/plugin-workspace-files.ts");
const { harness, OWNER_TOKEN } = await import("../packages/racp/dist/test-harness.js");
const { bindRacpWebSocket, wsClientTransport } = await import("../packages/racp/dist/index.js");

let application, binding, adapter, bridge, runtime, protocol;
let held, entered, heldRef = "late.txt";
const calls = [], invocations = [], errors = [], checks = [];
async function waitForSignal(promise, message) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}
try {
  const remotePath = join(temp, "remote-repository");
  const localPath = join(temp, "local-control");
  await mkdir(join(remotePath, "docs"), { recursive: true });
  await mkdir(localPath);
  await mkdir(join(remotePath, "nested"));
  await mkdir(join(localPath, "nested"));
  await writeFile(join(remotePath, "nested/deep.txt"), "REMOTE NESTED\n");
  await writeFile(join(localPath, "nested/deep.txt"), "WRONG LOCAL FILE\n");
  await writeFile(join(localPath, "page.html"), "<h1>Local page</h1>");
  await mkdir(join(temp, "host-data"));
  await writeFile(join(remotePath, "docs/guide.md"), "REMOTE CONTENT\n");
  await writeFile(join(remotePath, "late.txt"), "LATE REMOTE CONTENT\n");
  await writeFile(join(remotePath, ".env"), "PRIVATE FIXTURE");
  await writeFile(join(remotePath, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8sAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(localPath, "local.txt"), "LOCAL CONTROL\n");
  const identity = "remote-project:e2e";
  let workspace = identity;
  const groups = [{ id: "e2e", name: "SSH repository", primaryPath: identity,
    roots: [{ path: identity, name: "SSH repository", position: 0 }], remote: { hostKey: "fixture", path: remotePath } }];
  rememberProjectGroups(groups);
  const host = { async call(method) {
    assert.equal(method, "project.groups.list", "only durable binding lookup is stubbed"); return { groups };
  } };
  protocol = await harness({ operations: { workspacePluginFiles: createWorkspacePluginFiles({
    browseRoot: temp, protectedPaths: [join(temp, "host-data")],
  }) } });
  binding = await bindRacpWebSocket({ server: protocol.server, authenticator: protocol.authenticator,
    port: 0, log: () => {} });
  const makeAdapter = () => createRacpRemoteHostClient({ clientInfo: { name: "remote-files-e2e", version: "fixture" },
    transport: wsClientTransport({ url: `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`, token: OWNER_TOKEN }) });
  adapter = makeAdapter();
  await adapter.connect();
  const boot = { async workspacePluginFiles(_key, input) {
    calls.push(input);
    const result = await adapter.client.request("workspace/pluginFiles", input);
    if (held && input.ref === heldRef) {
      entered.resolve(); await held.promise;
    }
    return result;
  } };
  runtime = new PluginRuntime({
    hostEntry: join(root, "apps/desktop/electron/main/plugin-host-process.mjs"),
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return { postMessage: message => { if (child.connected) child.send(message); },
        onMessage: handler => child.on("message", handler), onExit: handler => child.on("exit", code => handler(code ?? 0)),
        kill: () => child.kill() };
    },
    getWorkspacePath: () => workspace,
    getWorkspaceInfo: () => pluginWorkspaceInfo(workspace),
    getAppearance: () => ({ theme: "light", base: "light", locale: "en", pluginTheme: null }),
    readRemoteWorkspaceFiles: createPluginWorkspaceReader({ getHost: () => host, getBoot: () => boot }),
  });
  await runtime.loadFromPath(pluginDir);
  // The small fixture bridge transports production panel calls without loading the user's Desktop.
  bridge = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/invoke");
      let body = ""; for await (const chunk of request) body += chunk;
      const { channel, payload } = JSON.parse(body);
      invocations.push({ workspace, channel, payload });
      const value = await runtime.invokePanelBridge("pi.file-manager", channel, payload);
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ value }));
    } catch (error) {
      response.statusCode = 500; response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((done, reject) => { bridge.once("error", reject); bridge.listen(0, "127.0.0.1", done); });
  const port = bridge.address().port;
  await writeFile(join(temp, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pluginBridge',{invoke:(channel,payload)=>ipcRenderer.invoke('bridge',channel,payload),
on:(event,handler)=>{const listener=(_e,payload)=>handler(payload);ipcRenderer.on('fixture:'+event,listener);return()=>ipcRenderer.removeListener('fixture:'+event,listener)}});`);
  await writeFile(join(temp, "main.cjs"), `const {app,BrowserWindow,ipcMain,session}=require('electron');
app.setPath('userData',${JSON.stringify(join(temp, "profile"))});
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
 ipcMain.handle('bridge',async(_event,channel,payload)=>{const response=await fetch('http://127.0.0.1:${port}/invoke',{method:'POST',body:JSON.stringify({channel,payload})});const body=await response.json();if(body.error)throw new Error(body.error);return body.value;});
 const window=new BrowserWindow({width:1100,height:800,webPreferences:{preload:${JSON.stringify(join(temp, "preload.cjs"))},sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await window.loadFile(${JSON.stringify(join(pluginDir, "views/index.html"))});
});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const electronBinary = process.env.PI_ELECTRON_BINARY || resolveElectronBinary(root).electronBinary;
  application = await _electron.launch({ executablePath: electronBinary, args: [join(temp, "main.cjs")], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.getByText("Remote · read-only: directory browsing and text/image previews", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Search files" }).isDisabled(), true);
  await page.locator('[role="treeitem"][data-path="docs"]').click();
  await page.locator('[role="treeitem"][data-path="docs/guide.md"]').click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("REMOTE CONTENT"));
  assert.equal(await page.locator(".cm-content").getAttribute("contenteditable"), "false");
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  await page.locator(".cm-content").click(); await page.keyboard.type("MUST NOT EDIT");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  assert.equal(await readFile(join(remotePath, "docs/guide.md"), "utf8"), "REMOTE CONTENT\n");
  assert.equal((await page.locator(".cm-content").textContent()).includes("MUST NOT EDIT"), false);
  await page.locator('[data-path="docs/guide.md"]').click({ button: "right" });
  assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Copy relative path", "Copy absolute path", "Refresh"]);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-path=".env"]').count(), 0);
  checks.push("remote nested navigation, real text, credentials hidden, editor/save/menu read-only");
  await page.locator('[data-path="pixel.png"]').click();
  await page.waitForFunction(() => [...document.images].some(image => image.complete && image.naturalWidth === 1));
  checks.push("real remote image bytes decoded in Chromium");

  await adapter.close();
  await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("tree").getByText(/disconnected/i).waitFor();
  adapter = makeAdapter(); await adapter.connect();
  await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator('[data-path="late.txt"]').waitFor();
  checks.push("disconnect is visible and refresh recovers without local substitution");
  held = Promise.withResolvers(); entered = Promise.withResolvers();
  await page.locator('[data-path="late.txt"]').click();
  await waitForSignal(entered.promise, "Remote preview never started");
  workspace = localPath;
  await page.locator('[data-path="local.txt"]').waitFor();
  held.resolve(); held = undefined;
  await page.locator('[data-path="local.txt"]').click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("LOCAL CONTROL"));
  assert.equal(await page.locator(".cm-content").getAttribute("contenteditable"), "true");
  assert.equal((await page.locator("body").textContent()).includes("LATE REMOTE CONTENT"), false);
  checks.push("project switch rejects late remote contents and restores local editing");
  await page.locator('[data-path="page.html"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Open with/ }).hover();
  await page.getByRole("menuitem", { name: /browser/i }).waitFor();
  await page.keyboard.press("Escape");
  assert(invocations.some(call => call.workspace === localPath && call.channel === "fm.editors"), "local editor detection must resume after a remote startup");
  checks.push("local Browser action and editor detection recover after remote startup");

  workspace = identity;
  await page.getByText("Remote · read-only: directory browsing and text/image previews", { exact: true }).waitFor();
  await page.locator('[data-path="nested"]').waitFor();
  held = Promise.withResolvers(); entered = Promise.withResolvers(); heldRef = "nested";
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("fixture:view:open", { path: "nested/deep.txt" }));
  await waitForSignal(entered.promise, "Ancestor listing never started");
  workspace = localPath;
  await page.getByText("Remote · read-only: directory browsing and text/image previews", { exact: true }).waitFor({ state: "hidden" });
  const released = held; held = undefined; released.resolve();
  await page.evaluate(() => window.pluginBridge.invoke("workspace.get"));
  await page.getByRole("banner").getByRole("button", { name: /Show file list/ }).click();
  await page.locator('[data-path="local.txt"]').click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("LOCAL CONTROL"));
  assert(!invocations.some(call => call.workspace === localPath && call.channel === "fm.read" && call.payload?.path === "nested/deep.txt"), "stale ancestor chain must not dispatch a read in the new workspace");
  checks.push("host-open ancestor loading stops when the workspace changes");
  assert(calls.some(call => call.operation === "list" && call.ref === "docs"));
  assert(calls.some(call => call.operation === "preview" && call.ref === "pixel.png"));
  assert(calls.every(call => call.path === remotePath && JSON.stringify(call.scope) === '["**"]'));
  assert.deepEqual(errors, []);
  if (process.env.PI_E2E_ARTIFACTS) {
    await mkdir(process.env.PI_E2E_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(process.env.PI_E2E_ARTIFACTS, "remote-files-local-control.png") });
  }
  console.log("REMOTE_FILE_MANAGER_E2E " + JSON.stringify({ ok: true, pluginDir, checks, remoteRequests: calls.length }));
} catch (error) {
  if (application && process.env.PI_E2E_ARTIFACTS) {
    await mkdir(process.env.PI_E2E_ARTIFACTS, { recursive: true });
    await (await application.firstWindow()).screenshot({ path: join(process.env.PI_E2E_ARTIFACTS, "remote-files-failure.png") });
  }
  throw error;
} finally {
  held?.resolve();
  await application?.close();
  if (runtime) await runtime.unload("pi.file-manager");
  if (bridge) await new Promise(done => bridge.close(done));
  await adapter?.close(); protocol?.server.close(); await binding?.close();
  await rm(temp, { recursive: true, force: true });
}
