#!/usr/bin/env node
// Real sandboxed preload, renderer recovery, Main IPC, and process restarts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const scratch = await mkdtemp(join(tmpdir(), "sidebar-recovery-e2e-"));
const alias = {
  "@pi-desktop/shared/protocol": join(root, "packages/shared/src/protocol.ts"),
  "@pi-desktop/shared/startup-animation": join(root, "packages/shared/src/startup-animation.ts"),
  "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
};
try {
  await writeFile(join(scratch, "index.html"), '<!doctype html><body><script src="renderer.js"></script>');
  await build({ entryPoints: [join(root, "apps/desktop/electron/preload/index.ts")], outfile: join(scratch, "preload.cjs"),
    bundle: true, platform: "node", format: "cjs", external: ["electron"], alias });
  await build({ stdin: { contents: `
    import { api } from './apps/desktop/src/lib/api.ts';
    import { restoreSidebarPreferences, saveSidebarPreferences, loadSidebarPreferences } from './apps/desktop/src/lib/sidebar-preferences.ts';
    window.sidebarE2E = {
      restore: () => restoreSidebarPreferences({read:api.getSidebarPreferences,write:api.setSidebarPreferences,listProjects:api.listProjects}),
      save: async value => {saveSidebarPreferences(value); await api.setSidebarPreferences(loadSidebarPreferences());},
      cached: () => localStorage.getItem('pi.desktop.sidebarPreferences'),
      unauthorized: () => api.setSidebarPreferences({sessionMeta:{},projectMeta:{},sessionView:{},openProjectPaths:['/forbidden']}),
    };`, resolveDir: root }, outfile: join(scratch, "renderer.js"), bundle: true, platform: "browser", format: "iife", alias });
  await build({ stdin: { contents: `
    import { app, BrowserWindow, ipcMain } from 'electron';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { IPC } from './packages/shared/src/protocol.ts';
    import { registerSidebarPreferencesIpc } from './apps/desktop/electron/main/ipc/sidebar-preferences-ipc.ts';
    const root = process.env.SIDEBAR_E2E_ROOT, mode = process.env.SIDEBAR_E2E_MODE;
    app.setPath('userData', join(root, 'chromium-' + mode));
    let primary;
    const handle = (channel, fn) => ipcMain.handle(channel, async (event,...args) => {
      try { return {ok:true,data:await fn(event,...args)}; }
      catch(error) { return {ok:false,error:{message:error.message,code:'PERMISSION_DENIED'}}; }
    });
    registerSidebarPreferencesIpc({dataDir:join(root,'data'),registrar:{handleWithEvent:handle,
      assertMainWindowSender:event => {
        if(event.sender !== primary?.webContents || event.senderFrame !== primary.webContents.mainFrame) throw new Error('Untrusted sender');
      }
    }});
    handle(IPC.invoke.projectList, async () => ({projects:[{path:'/synthetic/alpha'},{path:'/synthetic/beta'}]}));
    const open = async () => {
      const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(root,'preload.cjs')}});
      await window.loadFile(join(root,'index.html')); return window;
    };
    app.whenReady().then(async () => {
      primary = await open();
      const cachedBefore = await primary.webContents.executeJavaScript('window.sidebarE2E.cached()');
      const restored = await primary.webContents.executeJavaScript('window.sidebarE2E.restore()');
      if(mode === 'seed') {
        await primary.webContents.executeJavaScript('window.sidebarE2E.save('+JSON.stringify({...restored,
          openProjectPaths:['/synthetic/alpha'], projectMeta:{'/synthetic/alpha':{name:'Retained',collapsed:true}}, sessionMeta:{session:{pinned:true}}
        })+')');
      }
      const other = await open();
      const denied = await other.webContents.executeJavaScript('window.sidebarE2E.unauthorized().then(()=>false,()=>true)');
      other.destroy();
      writeFileSync(join(root,'result-'+mode+'.json'),JSON.stringify({cachedBefore,restored,denied}));
      primary.destroy(); app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1)});
    `, resolveDir: root }, outfile: join(scratch, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], alias });
  for (const mode of ["seed", "fresh", "restart"]) {
    const env = { ...process.env, SIDEBAR_E2E_ROOT: scratch, SIDEBAR_E2E_MODE: mode };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary, [join(scratch, "main.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    const result = JSON.parse(await readFile(join(scratch, "result-" + mode + ".json"), "utf8"));
    assert.equal(result.cachedBefore, null, "each restart has a fresh Chromium profile");
    assert.equal(result.denied, true, "a secondary renderer cannot replace the backup");
    assert.deepEqual(result.restored.openProjectPaths, mode === "seed" ? ["/synthetic/alpha", "/synthetic/beta"] : ["/synthetic/alpha"]);
    if (mode !== "seed") {
      assert.equal(result.restored.projectMeta["/synthetic/alpha"].name, "Retained");
      assert.equal(result.restored.projectMeta["/synthetic/alpha"].collapsed, true);
      assert.equal(result.restored.sessionMeta.session.pinned, true);
    }
  }
  console.log("PASS: catalog recovery, retained and closed tabs, metadata, three process starts with fresh Chromium profiles, and trusted-frame IPC.");
} finally { await rm(scratch, { recursive: true, force: true }); }
