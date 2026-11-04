#!/usr/bin/env node
/** Actual Rust/stdiorpc + Electron + production Review UI; never uses a user's profile or model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC } from "../packages/shared/dist/index.js";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
const root = repositoryRoot(), hostBinary = resolveHostBinary();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "review-e2e-"));
const screenshots = join(root, "docs/public/screenshots/review-history");
await mkdir(screenshots, { recursive: true });
try {
  await build({ entryPoints: [join(root, "scripts/e2e/review-history.tsx")], outfile: join(temp, "renderer.js"), bundle: true,
    platform: "browser", format: "esm", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"), "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") }, nodePaths: [join(root, "apps/desktop/node_modules")] });
  await build({ entryPoints: [join(root, "apps/desktop/electron/main/reviewed-file-open.ts")], outfile: join(temp, "reviewed-file-open.cjs"), bundle: true, platform: "node", format: "cjs" });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map(match => pathToFileURL(join(renderer, match[1])).href);
  assert(css.length, "Build the candidate desktop renderer first");
  await writeFile(join(temp, "index.html"), `<!doctype html><html><head><meta charset="utf-8">${css.map(url => `<link rel="stylesheet" href="${url}">`).join("")}<style>html,body,#root{height:100%;margin:0}.fixture{height:100%;display:flex;flex-direction:column;padding:12px;background:var(--ds-bg-primary);color:var(--ds-text-primary)}.fixture-label{flex:none;font-size:12px;padding:4px 8px 10px;color:var(--ds-text-muted)}.fixture-panel{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid var(--ds-border-default);border-radius:8px;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('piDesktop',{platform:process.platform,invoke:(channel,input)=>ipcRenderer.invoke('fixture:invoke',channel,input),on:()=>()=>{}});contextBridge.exposeInMainWorld('reviewFixture',{action:(name,input)=>ipcRenderer.invoke('fixture:action',name,input)});`);
  const channels = { [IPC.invoke.workspaceReviewTurns]: "review.turns", [IPC.invoke.workspaceReviewChanges]: "review.changes", [IPC.invoke.workspaceReviewContext]: "review.context", [IPC.invoke.workspaceReviewRollback]: "review.rollback", [IPC.invoke.workspaceReviewRollbackFile]: "review.rollbackFile" };
  await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');const fs=require('node:fs/promises');
app.setPath('userData',path.join(__dirname,'profile'));
let host,win,seed,copied='',runningTurn,hold=false,blocked,notifyBlocked,gate,release; const opened=[],revealed=[];
app.whenReady().then(async()=>{let watchdog;try{
const {Host}=await import(${JSON.stringify(pathToFileURL(join(root, "scripts/e2e/host.mjs")).href)});
const {seedReviewHistory}=await import(${JSON.stringify(pathToFileURL(join(root, "scripts/e2e/review-history-fixture.mjs")).href)});
host=new Host(${JSON.stringify(hostBinary)},path.join(__dirname,'data'));await host.start();
win=new BrowserWindow({show:false,width:920,height:760,useContentSize:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
win.webContents.on('console-message',event=>console.error(event.message));
ipcMain.handle('fixture:invoke',async(_event,channel,input)=>{if(channel===${JSON.stringify(IPC.invoke.pluginViews)})return {ok:true,data:[{pluginId:"pi.file-manager",viewId:"manager"}]};if(channel===${JSON.stringify(IPC.invoke.fsResolveRef)}){const target=path.toNamespacedPath(path.resolve(input.ref)),base=path.toNamespacedPath(path.join(__dirname,"workspace"));const rel=path.relative(base,target);if(rel.startsWith("..")||path.isAbsolute(rel))throw new Error("Outside fixture workspace");const stat=await fs.stat(target).catch(()=>null);return {ok:true,data:{match:stat?.isFile()?{root:"workspace",relativePath:rel.replaceAll(String.fromCharCode(92),"/"),absolutePath:target,matchedBy:"exact-absolute",projectRoot:{primary:true}}:null}};}if(channel===${JSON.stringify(IPC.invoke.fsOpen)}){opened.push(input);return {ok:true,data:{}};}if(channel===${JSON.stringify(IPC.invoke.fsReveal)}){revealed.push(input);return {ok:true,data:{}};}if(channel===${JSON.stringify(IPC.invoke.workspaceReviewOpenFile)}){const {openReviewedFile}=require('./reviewed-file-open.cjs');return {ok:true,data:await openReviewedFile(input,{target:(sessionId,snapshotId)=>host.call('review.fileTarget',{sessionId,snapshotId}),isCurrent:()=>true,stripPrefix:p=>p.replace(/^\\\\\\\\\\?\\\\(?=[A-Za-z]:\\\\)/,''),openPath:async path=>{opened.push({path,sessionId:input.sessionId,review:true});return '';},reveal:path=>revealed.push({path,sessionId:input.sessionId,review:true})})};}const method=${JSON.stringify(channels)}[channel];if(!method)throw new Error('Unexpected IPC '+channel);if(hold&&method==='review.changes'){notifyBlocked();await gate;}try{return {ok:true,data:await host.call(method,input)}}catch(error){return {ok:false,error:{code:error.errorCode||'INTERNAL',message:error.message}}}});
ipcMain.handle('fixture:action',async(_event,name,input)=>{switch(name){
case 'seed':seed=await seedReviewHistory(host,__dirname);return {session:seed.session,other:seed.other,round:seed.round,latest:seed.latest,firstSnapshot:seed.firstSnapshot,late:seed.lateMessage};
case 'currentSeed':return {session:seed.session,firstSnapshot:seed.firstSnapshot};
case 'late':return seed.appendLate();
case 'runningStart':runningTurn=await seed.startRunning();return;
case 'runningWrite':return seed.writeRunning(runningTurn);
case 'runningEnd':return seed.endRunning(runningTurn);
case 'holdReads':hold=true;blocked=new Promise(resolve=>notifyBlocked=resolve);gate=new Promise(resolve=>release=resolve);return;
case 'readBlocked':await blocked;return;
case 'releaseReads':hold=false;release();return;
case 'restart':await host.restart();return;
case 'readCurrent':return seed.readCurrent();
case 'resetCurrent':return seed.resetCurrent();
case 'copy':copied=input;return;
case 'clipboard':return copied;
case 'opened':return opened;
case 'revealed':return revealed;
case 'resize':win.setContentSize(input,760);return;
case 'screenshot':if(!/^review-(normal|narrow|overview|latest|menu)\\.png$/.test(input))throw new Error('Invalid screenshot');await fs.writeFile(path.join(${JSON.stringify(screenshots)},input),(await win.webContents.capturePage()).toPNG());return;
default:throw new Error('Unknown action '+name)}});
watchdog=setTimeout(()=>{console.error('Review fixture timed out');host.stop().finally(()=>app.exit(1))},90000);
await win.loadFile(path.join(__dirname,'index.html'));
const result=await win.webContents.executeJavaScript('window.reviewProbe().catch(error=>{console.error(error.stack);throw error})');
await win.loadFile(path.join(__dirname,'index.html'));
const restored=await win.webContents.executeJavaScript('window.reviewReloadProbe().catch(error=>{console.error(error.stack);throw error})');
result.checks.push(...restored.checks);console.log('REVIEW_HISTORY '+JSON.stringify(result));clearTimeout(watchdog);await host.stop();app.exit(0);
}catch(error){console.error(error);clearTimeout(watchdog);await host?.stop();app.exit(1)}});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 100000);
  let code; try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); } finally { clearTimeout(timer); }
  assert.equal(code, 0, output);
  const result = output.split(/\r?\n/).find(line => line.startsWith("REVIEW_HISTORY ")); assert(result, output); console.log(result);
  console.log("Preview screenshots: " + screenshots);
} finally { await rm(temp, { recursive: true, force: true }); }
