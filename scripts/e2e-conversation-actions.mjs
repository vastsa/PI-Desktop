#!/usr/bin/env node
/** Electron component integration, real store and menus with fixture host API. */
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
const temp = await mkdtemp(join(tmpdir(), "pi-conversation-actions-"));
await build({
  entryPoints: [join(root, "scripts/e2e/conversation-actions.tsx")],
  outfile: join(temp, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  loader: { ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
  },
  nodePaths: [join(root, "apps/desktop/node_modules")],
});
const styles = ["tokens", "base", "ui-kit", "overlays", "settings", "sessions", "chrome"];
await writeFile(
  join(temp, "styles.css"),
  (
    await Promise.all(
      styles.map((name) => readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")),
    )
  )
    .join("\n")
    .replace(/@theme(?: inline)?/g, ":root"),
);
await writeFile(
  join(temp, "index.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
<link rel="stylesheet" href="styles.css"><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
);
await writeFile(
  join(temp, "main.cjs"),
  `
const {app,BrowserWindow}=require('electron'); const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1040,height:700,show:false,
 webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 await win.loadFile(path.join(__dirname,'index.html'));
 try { const result=await win.webContents.executeJavaScript('conversationActionsProbe()');
 console.log('CONVERSATION_ACTIONS_PROBE '+JSON.stringify(result)); app.exit(result.ok?0:1);
 } catch(error){console.error(error);app.exit(1);}
}); app.on('window-all-closed',()=>app.quit());`,
);
const electronBinary =
  process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [join(temp, "main.cjs")], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (data) => {
    output += data;
  });
const timeout = setTimeout(() => child.kill("SIGTERM"), 30000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
clearTimeout(timeout);
console.log(
  output.split(/\r?\n/).find((line) => line.startsWith("CONVERSATION_ACTIONS_PROBE ")) ??
    output.slice(-4000),
);
assert.equal(code, 0, output.slice(-4000));
