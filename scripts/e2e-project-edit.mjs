#!/usr/bin/env node
/** Real ProjectsPage/editor integration; only the host IPC boundary is a fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const interactive = process.argv.includes("--interactive");
const temp = await mkdtemp(join(tmpdir(), "pi-project-edit-"));
await build({
  entryPoints: [join(root, "scripts/e2e/project-edit.tsx")],
  outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
  nodePaths: [join(root, "apps/desktop/node_modules")],
});
const styles = ["tokens", "base", "ui-kit", "overlays", "settings", "projects", "project-create-dialog"];
await writeFile(join(temp, "styles.css"), (await Promise.all(styles.map(name =>
  readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8"))))
  .join("\n").replace(/@theme(?: inline)?/g, ":root") + `
  body { margin: 0; background: #f7f7f7; }
  .fixture-page { padding: 120px 60px 30px; height: 100vh; overflow: auto; }
  .fixture-controls { position: fixed; z-index: 2147483647; inset: 0 0 auto;
    display: flex; align-items: center; gap: 18px; padding: 14px 24px;
    background: #171717; color: white; font: 13px system-ui; }
  .fixture-controls button { background: white; color: #171717; padding: 8px 12px; border-radius: 6px; }
  .fixture-controls small { margin-left: auto; color: #ccc; }
`);
await writeFile(join(temp, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
<link rel="stylesheet" href="styles.css"><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
await writeFile(join(temp, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('piDesktop',{invoke:(channel,...args)=>ipcRenderer.invoke(channel,...args)});`);
await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
let group={id:'website',name:'Website',primaryPath:'/fixture/website',lastOpenedAt:1,pinned:false,
 roots:[{path:'/fixture/website',name:'website',position:0},{path:'/fixture/assets',name:'assets',position:1}]};
ipcMain.handle('pi-desktop/project-group/list',()=>({ok:true,data:{groups:[group]}}));
ipcMain.handle('pi-desktop/project-group/update',(_event,input)=>{
 group={...group,name:input.name,roots:input.folders.map((p,i)=>({path:p,name:path.basename(p),position:i}))};
 return {ok:true,data:{group}};
});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({title:'Project editor regression',width:1280,height:900,show:${interactive},
 webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 await win.loadFile(path.join(__dirname,'index.html'));
 ${interactive ? "console.log('PROJECT_EDIT_INTERACTIVE '+__dirname);" : `try {
   const result=await win.webContents.executeJavaScript('projectEditProbe()');
   console.log('PROJECT_EDIT_PROBE '+JSON.stringify(result));
   app.exit(result.ok?0:1);
 } catch(error){console.error(error);app.exit(1);}`}
});
app.on('window-all-closed',()=>app.quit());
`);
const electronBinary = process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
  output += data;
  if (interactive) process.stdout.write(data);
});
const timeout = interactive ? null : setTimeout(() => child.kill("SIGTERM"), 30000);
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
if (timeout) clearTimeout(timeout);
if (!interactive) {
  const line = output.split(/\r?\n/).find(line => line.startsWith("PROJECT_EDIT_PROBE "));
  console.log(line ?? output.slice(-3000));
  assert.equal(code, 0, output.slice(-3000));
}
