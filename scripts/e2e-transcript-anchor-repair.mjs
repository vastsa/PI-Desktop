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
const injectDrift = process.argv.includes("--inject-drift");
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
const assert=require('node:assert/strict');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,width:900,height:720,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>console.error(e.message));
 try{
  await win.loadFile(require('node:path').join(__dirname,'index.html'));
  const js=expression=>win.webContents.executeJavaScript(expression);
  const call=expression=>js('globalThis.transcriptAnchorRepairFixture.'+expression);
  const results=[];
  for(const kind of ['ordinary-shrink','browser-clamp','paragraph-remount','balanced-remount','reader-scroll','unreachable']) {
    const prepared=await call('prepareCase('+JSON.stringify(kind)+')');
    const before=(await win.webContents.capturePage(prepared.crop)).toBitmap();
    assert(new Set(before).size>8,'Empty/uniform painted text');
    const result=await call('mutateCase(${injectDrift})');
    const painted=(await win.webContents.capturePage(prepared.crop)).toBitmap();
    if(!['reader-scroll','unreachable'].includes(kind)) result.identicalPaint=before.equals(painted);
    results.push(result);
  }
  const text=await call('textContracts()');
  console.log('TRANSCRIPT_TEXT_ANCHOR '+JSON.stringify(text));
  assert(text.character>0&&text.reconstructed&&text.resolved&&text.rejectedEdit&&text.rejectedMissing&&text.fallbackLegal&&text.fallbackStable,'Text identity/fallback contract failed');
  assert(text.drift<2&&text.maxFrameDrift<2,'Intra-paragraph character moved');
  const nativeResults=[];
  for(const withLayout of [false,true]) {
    const input=await call('prepareNative('+withLayout+')');
    win.focus();
    win.webContents.sendInputEvent({type:'mouseMove',x:input.x,y:input.y});
    win.webContents.sendInputEvent({type:'mouseWheel',x:input.x,y:input.y,deltaY:60,deltaX:0,canScroll:true});
    const native=await call('nativeResult()');
    nativeResults.push({input,native});
    assert(!native.nativeLayout&&native.top>2&&native.top<280,'Native input did not move the reader without hitting a boundary');
    assert.equal(native.observerWarnings.length,0,'Unexpected ResizeObserver notification loop');
    assert(Math.abs(native.actual-input.baseline-(300-native.top))<2,'Native input was confused with layout movement');
    if(withLayout) assert(native.clamped<800,'Same-delivery layout did not clamp');
  }
  console.log('TRANSCRIPT_NATIVE_CLAMP '+JSON.stringify(nativeResults));
  assert(Math.abs(nativeResults[0].native.top-nativeResults[1].native.top)<2,'Layout swallowed part of native input');
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
  for (const result of results) {
    assert(result.samples >= 8 && result.maxFrameDrift < 2, "A sampled frame drifted: " + JSON.stringify(result));
    assert.equal(result.repeatedWrites, 0, "Stable/boundary restore repeated a scroll write");
    if (result.identicalPaint !== undefined) assert.equal(result.identicalPaint, true, "Painted text changed: " + result.kind);
    if (result.kind.includes("remount")) assert.equal(result.replaced && !result.connected, true);
    if (result.kind === "balanced-remount") assert.equal(result.oldHeight, result.height);
    if (result.kind === "unreachable") assert.equal(result.top, 0);
  }
  assert(results.every(result => result.drift < 2), "Same readable paragraph moved: " + JSON.stringify(results));
} finally { await rm(temp, { recursive: true, force: true }); }
