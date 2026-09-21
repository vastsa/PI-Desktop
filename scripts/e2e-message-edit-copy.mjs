#!/usr/bin/env node
// Real Chromium selection and production message components; no host or provider.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const cache = join(root, ".cache/message-edit-copy");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "run-"));
await require("esbuild").build({
  entryPoints: [join(root, "scripts/e2e/message-edit-copy.tsx")],
  outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife",
  loader: { ".css": "empty" }, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  alias: { react: join(desktop, "node_modules/react"), "react-dom": join(desktop, "node_modules/react-dom") },
  nodePaths: [join(desktop, "node_modules")],
});
await writeFile(join(temp, "index.html"), '<!doctype html><html><body><script src="renderer.js"></script></body></html>');
await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  try {
    const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true}});
    await win.loadFile(require('node:path').join(__dirname,'index.html'));
    console.log(await win.webContents.executeJavaScript('globalThis.messageEditCopyProbe()'));
    app.exit(0);
  } catch(error) { console.error(error); app.exit(1); }
});`);
const result = spawnSync(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { stdio: "inherit", timeout: 30000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
