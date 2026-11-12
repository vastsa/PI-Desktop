#!/usr/bin/env node
/** Real React/Markdown/Chromium geometry; synthetic state, no Host or providers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? root, "transcript-anchor-"));
try {
  await build({ entryPoints: [join(root, "scripts/e2e/transcript-anchor-repair.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
    loader: { ".css": "empty" }, alias: {
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")], plugins: [{ name: "assets", setup(b) {
      b.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: join(resolveDir, path.slice(0, -4)), namespace: "asset" }));
      b.onLoad({ filter: /.*/, namespace: "asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
    } }],
  });
  await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><title>Transcript anchor repair</title><script type="module" src="renderer.js"></script>');
  await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,width:900,height:720,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>console.error(e.message));
 try{
  await win.loadFile(require('node:path').join(__dirname,'index.html'));
  const results=await win.webContents.executeJavaScript('globalThis.transcriptAnchorRepairProbe()');
  console.log('TRANSCRIPT_ANCHOR_REPAIR '+JSON.stringify(results));
  app.exit(0);
 }catch(e){console.error(e.stack||String(e));app.exit(1);}
});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; process.stdout.write(data); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output.slice(-4000));
  const line = output.split(/\r?\n/).find(line => line.startsWith("TRANSCRIPT_ANCHOR_REPAIR "));
  assert(line, "Missing actual Chromium results");
  const results = JSON.parse(line.slice("TRANSCRIPT_ANCHOR_REPAIR ".length));
  const clamp = results.find(result => result.kind === "browser-clamp");
  assert(clamp.clamped < clamp.oldTop, "Fixture did not trigger native boundary clamping");
  assert.equal(results.find(result => result.kind === "paragraph-remount").replaced, true);
  assert(results.every(result => result.drift < 2), "Same readable paragraph moved: " + JSON.stringify(results));
} finally { await rm(temp, { recursive: true, force: true }); }
