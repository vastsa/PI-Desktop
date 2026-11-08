import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

test("a concurrent unrelated IPC cannot replace the Host used to resolve scratch images", async () => {
  const temp = await mkdtemp(new URL("../.scratch-ref-test-", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
  try {
    const scratch = join(temp, "scratch", "session");
    const workspace = join(temp, "workspace");
    await mkdir(workspace);
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, "image.png"), "fixture image");
    const bundle = join(temp, "workspace.mjs");
    await build({ entryPoints: [new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")],
      outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
      plugins: [{ name: "electron-edge", setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
export const app = { isPackaged: false, getPath: () => "", getVersion: () => "0.21.0" };
export const clipboard = {}, dialog = {}, shell = {}, session = {}, nativeImage = {}, ipcMain = {}, systemPreferences = {}, screen = {};
export class BrowserWindow {};
export class WebContentsView {};
` }));
      } }],
    });
    const { registerWorkspaceIpc } = await import(pathToFileURL(bundle));
    const { IPC } = await import("@pi-desktop/shared");
    const handlers = new Map();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const owner = { async call(method) {
      if (method === "session.get") { await pending; return { session: { projectPath: workspace } }; }
      if (method === "session.getScratchPath") return { path: scratch };
      throw new Error("Unexpected Host RPC: " + method);
    } };
    let active = owner;
    registerWorkspaceIpc({
      registrar: { handle: (channel, fn) => handlers.set(channel, fn), handleWithEvent() {}, assertMainWindowSender() {} },
      getHost: () => active, getSidecar: () => null, getMainWindow: () => null,
      dataDir: temp, plugins: {}, browserHost: { getState: () => null }, clipboardHistory: {},
      currentWorkspacePath: () => workspace, setCurrentWorkspacePath() {}, withGitBranch: value => value,
      stripWinLongPrefix: value => value,
    });
    const reading = handlers.get(IPC.invoke.fsResolveRef)({ sessionId: "session", ref: "image.png" });
    active = null;
    await handlers.get(IPC.invoke.browserGetState)();
    active = owner;
    release();
    const result = await reading;
    assert.equal(result.match?.absolutePath, join(scratch, "image.png"));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
