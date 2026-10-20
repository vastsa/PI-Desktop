#!/usr/bin/env node
/** Isolated Electron visual regression using production UI and renderer CSS.
 * Host responses are fixtures; this does not validate Rust persistence or updates.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const darkOnly = process.argv.includes("--dark-only");
const outDir = join(root, ".artifacts", "pr854");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const depsRoot = join(root, "apps", "desktop", "node_modules");
const localElectron = join(depsRoot, "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const electron = process.env.PI_DESKTOP_ELECTRON || (existsSync(localElectron) ? localElectron : resolveElectronBinary(root).electronBinary);
const temp = await mkdtemp(join(tmpdir(), "pi-queued-animation-"));
let child;
try {
  await mkdir(join(outDir, "frames"), { recursive: true });
  await build({
    entryPoints: [join(root, "scripts/e2e/queued-prompt-animation.jsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"),
      react: join(depsRoot, "react"), "react-dom": join(depsRoot, "react-dom"),
      i18next: join(depsRoot, "i18next"), "react-i18next": join(depsRoot, "react-i18next") },
    nodePaths: [depsRoot],
    loader: { ".png": "file", ".jpg": "file", ".gif": "file", ".webp": "file", ".svg": "file", ".woff": "file", ".woff2": "file", ".ttf": "file" },
    plugins: [{ name: "url-assets", setup(b) {
      b.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path.slice(0, -4)), namespace: "url-asset" }));
      b.onLoad({ filter: /.*/, namespace: "url-asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
    } }],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const primaryCss = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((m) => m[1]);
  assert(primaryCss.length, "Build the current production renderer before capture");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  const css = [...new Set([...primaryCss, ...(await readdir(join(renderer, "assets"))).filter((f) => f.endsWith(".css")).map((f) => `./assets/${f}`)])];
  if (existsSync(join(temp, "renderer.css"))) css.push("./renderer.css");
  const csp = html.match(/content="(default-src[^"]+)"/)?.[1];
  assert(csp, "Production renderer CSP must be present");
  await writeFile(join(temp, "index.html"), `<!doctype html><html data-platform="win32"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${css.map((p) => `<link rel="stylesheet" href="${p}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
  const main = String.raw`
const {app,BrowserWindow}=require("electron");
const fs=require("node:fs/promises"); const path=require("node:path"); const assert=require("node:assert/strict");
const out=process.env.QUEUE_CAPTURE_OUT;
app.setPath("userData",path.join(__dirname,"profile"));
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,frame:false,useContentSize:true,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.showInactive();
  const errors=[];
  win.webContents.on("console-message", (event)=>{if(event.level==='error') errors.push(event.message);});
  const run=(expr)=>win.webContents.executeJavaScript(expr);
  const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
  const shot=async(name,rect)=>{const image=await win.webContents.capturePage(rect); await fs.writeFile(path.join(out,name+".png"),image.toPNG());};
  const captureDark=async()=>{
    await run("window.__QUEUE_CAPTURE__.theme('dark')");
    await run("window.__QUEUE_CAPTURE__.view('settings')");
    assert.equal(await run("document.documentElement.dataset.theme"),'dark');
    await shot('settings-dark-full-1200x800');
    await run("window.__QUEUE_CAPTURE__.openOptions()");
    await shot('settings-options-dark-full');
    const rect=await run("window.__QUEUE_CAPTURE__.rect('setting')");
    rect.y=Math.max(0,rect.y-10); rect.height=Math.min(800-rect.y,rect.height+220);
    await shot('settings-options-dark-closeup',rect);
    await run("window.__QUEUE_CAPTURE__.choose('Off (default)')");
    const result={viewport:{width:1200,height:800},fixture:'Production UI with isolated fixture host responses',variants:{},errors};
    for(const [variant,label] of Object.entries({off:'Off (default)',bubbles:'Bubbles',glow:'Glow',wave:'Waterline'})){
      await run("window.__QUEUE_CAPTURE__.view('settings')");
      await run("window.__QUEUE_CAPTURE__.openOptions()");
      await run("window.__QUEUE_CAPTURE__.choose("+JSON.stringify(label)+")");
      await run("window.__QUEUE_CAPTURE__.view('chat')");
      await delay(350);
      const state=await run("window.__QUEUE_CAPTURE__.state()");
      assert.equal(state.theme,'dark'); assert.equal(state.rootAnimation,variant); assert.equal(state.preference,variant);
      assert.equal(state.queuedRows,2); assert.equal(state.ordinaryContent,'none');
      if(variant==='off') assert.equal(state.content,'none'); else assert.notEqual(state.content,'none');
      if(variant==='wave') assert(state.background.includes("stroke='white'"),'Dark waterline must use white ink');
      await shot('chat-'+variant+'-dark-full');
      await shot('queue-'+variant+'-dark-closeup',await run("window.__QUEUE_CAPTURE__.rect('.composer-queued-prompts')"));
      result.variants[variant]=state;
    }
    assert.equal(errors.length,0,'Renderer must not report errors during dark capture');
    await fs.writeFile(path.join(out,'capture-dark-result.json'),JSON.stringify(result,null,2));
    return result;
  };
  try {
    await win.loadFile(path.join(__dirname,"index.html"));
    for(let i=0;i<100;i++){ if(await run("Boolean(window.__QUEUE_CAPTURE__ && document.querySelector('.settings-row'))")) break; await delay(100); }
    assert(await run("Boolean(document.querySelector('.settings-row'))"),"Shell did not mount: "+errors.join("\n"));
    if(process.env.QUEUE_CAPTURE_DARK_ONLY==='1'){
      await captureDark();
      console.log('QUEUE_CAPTURE '+JSON.stringify({ok:true,out,mode:'dark-only'})); app.exit(0); return;
    }
    await run("window.__QUEUE_CAPTURE__.view('settings')");
    await shot("settings-full-1200x800");
    await run("window.__QUEUE_CAPTURE__.openOptions()");
    await shot("settings-options-full");
    const rect=await run("window.__QUEUE_CAPTURE__.rect('setting')");
    rect.y=Math.max(0,rect.y-10); rect.height=Math.min(800-rect.y,rect.height+220);
    await shot("settings-options-closeup",rect);
    await run("window.__QUEUE_CAPTURE__.choose('Bubbles')");
    await run("window.__QUEUE_CAPTURE__.view('chat')");
    await delay(500);
    const variants={off:"Off (default)",bubbles:"Bubbles",glow:"Glow",wave:"Waterline"};
    const result={viewport:{width:1200,height:800},fixture:"Production AppShell, SettingsPage, Composer, store and CSS; isolated fixture host responses",variants:{},errors};
    win.webContents.debugger.attach('1.3');
    for(const [variant,label] of Object.entries(variants)){
      await run("window.__QUEUE_CAPTURE__.view('settings')");
      await run("window.__QUEUE_CAPTURE__.openOptions()");
      await run("window.__QUEUE_CAPTURE__.choose("+JSON.stringify(label)+")");
      await run("window.__QUEUE_CAPTURE__.view('chat')");
      const state=await run("window.__QUEUE_CAPTURE__.state()");
      assert.equal(state.preference,variant); assert.equal(state.rootAnimation,variant); assert.equal(state.queuedRows,2);
      assert.equal(state.ordinaryContent,"none");
      if(variant==='off') assert.equal(state.content,"none"); else assert.notEqual(state.content,"none");
      if(variant==='wave') assert(state.background.includes("stroke='%231a1c1f'"),"Light waterline must use dark ink");
      await shot("chat-"+variant+"-full");
      const queueRect=await run("window.__QUEUE_CAPTURE__.rect('.composer-queued-prompts')");
      await shot("queue-"+variant+"-closeup",queueRect);
      if(variant!=='off'){
        const start=Date.now();
        for(let i=0;i<70;i++){
          await delay(Math.max(0,start+i*100-Date.now()));
          await shot("frames/"+variant+"-"+String(i).padStart(3,'0'),queueRect);
        }
      }
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await delay(80);
      const reduced=await run("window.__QUEUE_CAPTURE__.state()"); if(variant!=='off') assert.equal(reduced.display,"none");
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
      result.variants[variant]={state,reducedMotionDisplay:reduced.display};
      await fs.writeFile(path.join(out,'capture-progress.json'),JSON.stringify(result,null,2));
    }
    await captureDark();
    result.dark=await run("window.__QUEUE_CAPTURE__.state()"); assert.equal(result.dark.theme,'dark');
    assert(result.dark.background.includes("stroke='white'"),"Dark waterline must use white ink");
    win.webContents.reload(); await delay(1000);
    result.fixtureReload=await run("window.__QUEUE_CAPTURE__.state()"); assert.equal(result.fixtureReload.preference,'wave'); assert.equal(result.fixtureReload.rootAnimation,'wave');
    await fs.writeFile(path.join(out,'capture-result.json'),JSON.stringify(result,null,2));
    console.log('QUEUE_CAPTURE '+JSON.stringify({ok:true,out})); app.exit(0);
  }catch(e){console.error(e.stack);console.error(errors.join('\n'));app.exit(1);}
});`;
  await writeFile(join(temp, "main.cjs"), main);
  const env = { ...process.env, QUEUE_CAPTURE_OUT: outDir, QUEUE_CAPTURE_DARK_ONLY: darkOnly ? "1" : "0" }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [join(temp, "main.cjs")], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (b) => { output += b; });
  const timer = setTimeout(() => child.kill(), 180_000);
  let code;
  try { code = await new Promise((res, rej) => { child.once("error", rej); child.once("close", res); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const metadata = { commit: git("rev-parse", "HEAD"), base: git("rev-parse", "upstream/main"), worktreeStatus: git("status", "--short"), capturedAt: new Date().toISOString(),
    limits: ["Isolated fixture host responses; no Rust Host persistence, agent execution or automatic update tested", darkOnly ? "Static dark-theme screenshots generated by Electron" : "7 seconds at 10 fps per effect; screenshot frames are generated by Electron"] };
  await writeFile(join(outDir, darkOnly ? "capture-dark-metadata.json" : "capture-metadata.json"), JSON.stringify(metadata, null, 2));
  console.log(output.trim());
} finally {
  if (child && child.exitCode === null) child.kill();
  assert(resolve(temp).startsWith(resolve(tmpdir()) + sep), "Temporary cleanup must remain inside the system temp directory");
  await rm(temp, { recursive: true, force: true });
}
