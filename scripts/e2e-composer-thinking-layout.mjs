#!/usr/bin/env node
/** Isolated Electron geometry regression; never connects to the user's app or providers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const runtimeRequire = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = runtimeRequire("esbuild");
const vite = await import(pathToFileURL(require.resolve("vite")).href);
const { default: tailwind } = await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href);
const cache = join(root, ".cache/composer-thinking-layout");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "run-"));
const styles = await vite.build({
  configFile: false, root: desktop, logLevel: "error", plugins: [tailwind()],
  build: { write: false, rollupOptions: { input: join(desktop, "src/styles/globals.css") } },
});
const outputs = (Array.isArray(styles) ? styles : [styles]).flatMap((result) => result.output);
const css = outputs.filter((entry) => entry.type === "asset" && entry.fileName.endsWith(".css"));
assert(css.length > 0, "Production CSS was not compiled");
await writeFile(join(temp, "styles.css"), css.map((entry) => entry.source).join("\n"));
await build({
  entryPoints: [join(root, "scripts/e2e/composer-thinking-layout.tsx")],
  outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  alias: { react: join(desktop, "node_modules/react"), "react-dom": join(desktop, "node_modules/react-dom") },
  nodePaths: [join(desktop, "node_modules")],
});
await writeFile(join(temp, "index.html"), `<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styles.css"><body><script src="renderer.js"></script></body></html>`);
await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.setPath('crashDumps',path.join(__dirname,'crashes'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,width:1040,height:760,
    webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try {
    await window.loadFile(path.join(__dirname,'index.html'));
    const result=await window.webContents.executeJavaScript('globalThis.composerThinkingLayoutProbe()');
    result.motion=await window.webContents.executeJavaScript('globalThis.thinkingSliderMotionProbe()');
    if(!result.motion.ok) result.failures.push('Motion: '+result.motion.error);
    const probe=expression=>window.webContents.executeJavaScript('globalThis.composerThinkingPointerProbe.'+expression);
    await probe('mount()');
    const click=async(level)=>{
      const point=await probe('target('+JSON.stringify(level)+')');
      window.webContents.sendInputEvent({type:'mouseMove',...point});
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      await probe('settle()');
      if(level===undefined && !(await probe('pressed()'))) throw new Error('Native click did not activate trigger');
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      await probe('settle()');
    };
    result.pointerCycles=[];
    for(let cycle=0;cycle<3;cycle++){
      await click();
      const opened=await probe('snapshot()');
      const selections=[];
      for(const level of ['low','high','omit']){
        await click(level);
        const selected=await probe('snapshot()');
        selections.push(selected);
        if(selected.level!==level) result.failures.push('Mouse selection did not persist '+level);
        if(Math.abs(selected.left-opened.left)>0.05 || Math.abs(selected.top-opened.top)>0.05)
          result.failures.push('Open cycle '+cycle+'/'+level+': menu moved '+(selected.left-opened.left)+'px horizontally, '+(selected.top-opened.top)+'px vertically');
      }
      result.pointerCycles.push({opened,selections});
      await click();
    }
    await click();
    await click('low');
    const hoverSnapshot=()=>window.webContents.executeJavaScript(\`(() => {
      const dots=[...document.querySelectorAll('.composer-thinking-dot')];
      const ticks=[...document.querySelectorAll('.composer-thinking-tick')];
      const hovered=dots.findIndex(dot=>dot.hasAttribute('data-hovered'));
      return {hovered, tick:ticks.findIndex(tick=>tick.hasAttribute('data-hovered')),
        width:hovered<0?0:dots[hovered].getBoundingClientRect().width,
        halo:hovered<0?'none':getComputedStyle(dots[hovered]).boxShadow,
        thumbWidth:document.querySelector('.composer-thinking-thumb').getBoundingClientRect().width,
        thumbHalo:getComputedStyle(document.querySelector('.composer-thinking-thumb')).boxShadow,
        value:document.querySelector('.composer-thinking-range').getAttribute('aria-valuetext')};
    })()\`);
    result.hover=[];
    for(const stop of [0,1,2,4]){
      for(const row of ['dot','tick']){
        const point=await window.webContents.executeJavaScript(\`(() => {
          const r=document.querySelectorAll('.composer-thinking-\${row}')[\${stop}].getBoundingClientRect();
          return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
        })()\`);
        window.webContents.sendInputEvent({type:'mouseMove',...point});
        await probe('settle()');
        const hovered=await hoverSnapshot();
        result.hover.push({stop,row,...hovered});
        if(hovered.halo!=='none' || hovered.thumbHalo!=='none')
          result.failures.push('Hover unexpectedly added a halo');
        if(hovered.hovered!==stop || hovered.tick!==stop || Math.abs(hovered.width-(stop>2?5.2:4))>0.1 || hovered.value!=='low' || Math.abs(hovered.thumbWidth-14)>0.1)
          result.failures.push('Hover did not link dot and label without selection: '+JSON.stringify({stop,row,...hovered}));
      }
    }
    window.webContents.sendInputEvent({type:'mouseMove',x:5,y:5});
    await probe('settle()');
    if((await hoverSnapshot()).hovered!==-1 || (await hoverSnapshot()).tick!==-1)
      result.failures.push('Hover remained after leaving slider');
    await click('omit');
    await probe('focusRange()');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await probe('settle()');
    if((await probe('snapshot()')).level!=='off' || !(await probe('motionState()')).focused)
      result.failures.push('Native keyboard selection or input focus was lost');
    const dragStart=await probe('railTarget(1)');
    const dragEnd=await probe('railTarget(3)');
    window.webContents.sendInputEvent({type:'mouseMove',...dragStart});
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...dragStart});
    window.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],...dragEnd});
    await probe('frame()');
    result.drag=await probe('motionState()');
    result.drag.selection=await probe('snapshot()');
    if(!result.drag.dragging || result.drag.animations!==0 || Math.abs(result.drag.gap)>0.6 || (await probe('snapshot()')).level!=='high')
      result.failures.push('Native drag did not follow the pointer immediately');
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...dragEnd});
    await probe('settle()');
    if((await probe('motionState()')).dragging) result.failures.push('Drag state survived pointer release');
    require('node:fs').writeFileSync(path.join(__dirname,'slider.png'),(await window.webContents.capturePage({x:380,y:155,width:350,height:205})).toPNG());
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await window.webContents.executeJavaScript("document.querySelectorAll('.composer-thinking-tick')[0].click()");
    await probe('frame()');
    result.reduced=await probe('motionState()');
    if(result.reduced.animations!==0 || Math.abs(result.reduced.gap)>0.6 || (await probe('snapshot()')).level!=='omit') result.failures.push('Reduced motion selection did not update immediately');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    window.webContents.debugger.detach();
    result.ok=result.failures.length===0;
    console.log('THINKING_LAYOUT_RESULT '+JSON.stringify(result));
    app.exit(result.ok?0:1);
  } catch(error) {console.error(String(error));app.exit(1);}
});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
const timeout = setTimeout(() => child.kill("SIGKILL"), 40_000);
let code;
try {
  code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
} finally { clearTimeout(timeout); }
const line = output.split(/\r?\n/).find((entry) => entry.startsWith("THINKING_LAYOUT_RESULT "));
assert(line, `No geometry result (exit ${code}): ${output.slice(-2000)}`);
const result = JSON.parse(line.slice("THINKING_LAYOUT_RESULT ".length));
await writeFile(join(temp, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, checks: result.measurements.length, motion: result.motion, drag: result.drag, reduced: result.reduced, failures: result.failures, artifacts: temp }));
assert.equal(result.ok, true, result.failures.join("\n"));
assert.equal(code, 0);
