#!/usr/bin/env node
/** Exercise streaming block lifecycle with the production slot host in isolated Electron. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "pi-streaming-fences-"));
const require = createRequire(join(root, "package.json"));
let server;
try {
  await build({ stdin: { contents: 'export * as React from "react"; export {createRoot} from "react-dom/client"; export {flushSync} from "react-dom"; export {PluginBlockRenderer} from "./apps/desktop/src/components/PluginBlockRenderer.tsx"; export {slotRegistry} from "./apps/desktop/src/plugins/renderer-slots/registry.ts"; export {SlotSessionProvider,useSlotEntryForKey} from "./apps/desktop/src/plugins/renderer-slots/use-slots.tsx";', resolveDir: root, loader: "ts" }, outfile: join(scratch, "host.mjs"), bundle: true, format: "esm", platform: "browser", alias: {"@pi-desktop/plugin-sdk":join(root,"packages/plugin-sdk/src/index.ts")}, define: { "process.env.NODE_ENV": '"production"' } });
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import {React,createRoot,flushSync,PluginBlockRenderer,slotRegistry,SlotSessionProvider,useSlotEntryForKey} from '/host.mjs';
try {
  const h=React.createElement;
  const assert=(condition,message)=>{if(!condition)throw new Error(message);};
  function Probe(props){
    const [count,setCount]=React.useState(0);
    if(props.source==='error')throw new Error('fixture render failure');
    return h('section',props.source==='overflow'?{'data-grow':true,style:{height:'4000px'}}:null,h('output',null,JSON.stringify(props)),h('button',{onClick:()=>setCount(v=>v+1)},String(count)));
  }
  const register=streaming=>slotRegistry.register('demo.lab',{slot:'blockRenderer',language:'demo.lab:chart',...(streaming?{streaming:true}:{}),component:Probe});
  function Harness(props){
    const entry=useSlotEntryForKey('blockRenderer','demo.lab:chart');
    const fallback=h('pre',{'data-fallback':true},props.source);
    return entry?h(PluginBlockRenderer,{...props,entry,language:'demo.lab:chart',sourcePosition:{'data-source-start':8,'data-source-end':40},fallback}):fallback;
  }
  const rootView=createRoot(document.querySelector('#root'));
  const render=(source,closed=false,streaming=true)=>flushSync(()=>rootView.render(h(SlotSessionProvider,{sessionId:'original-session'},h(Harness,{source,closed,streaming,messageId:'reply-7',fenceId:'8'}))));
  const props=()=>JSON.parse(document.querySelector('output').textContent);
  let dispose=register(true);
  render('partial');
  assert(props().closed===false && props().streaming===true,'partial lifecycle');
  assert(props().sessionId==='original-session' && props().messageId==='reply-7' && props().fenceId==='8','original identity');
  flushSync(()=>document.querySelector('button').click());
  render('complete',true,true);
  assert(props().source==='complete' && document.querySelector('button').textContent==='1','source update remounted local state');
  render('complete',true,false);
  assert(props().streaming===false && props().closed===true,'terminal update with unchanged source');
  assert(document.querySelector('[data-source-start="8"]'),'source anchor');
  flushSync(()=>dispose());
  assert(document.querySelector('[data-fallback]')?.textContent==='complete','unload fallback');
  dispose=register(false);
  render('legacy',true,false);
  assert(Object.keys(props()).sort().join(',')==='language,source','legacy props changed');
  render('later',true,false);
  assert(props().source==='legacy','legacy props-once changed');
  flushSync(()=>dispose());
  dispose=register(true);
  render('small',true,false);
  render('overflow',true,false);
  document.querySelector('[data-grow]').style.height='4001px';
  await new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error('overflow fallback missing'));},5000);
    function check(){if(document.querySelector('[data-fallback]')?.textContent==='overflow'){clearTimeout(timer);observer.disconnect();resolve();}}
    observer.observe(document.body,{childList:true,subtree:true});check();
  });
  flushSync(()=>dispose());
  dispose=register(true);
  render('error',true,false);
  assert(document.querySelector('[data-fallback]')?.textContent==='error','error fallback');
  flushSync(()=>dispose());rootView.unmount();
  window.__streamSmoke={ok:true,checks:['incremental source','stable local state','terminal lifecycle','original identity','legacy props-once','unload','asynchronous overflow','error fallback']};
}catch(error){window.__streamSmoke={ok:false,error:error.stack};}
</script></body></html>`;
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    try {
      const bytes = path === "/" ? page : path === "/host.mjs" ? await readFile(join(scratch, "host.mjs")) : path === "/plugin.mjs" ? 'import {jsx} from "react/jsx-runtime"; import {jsxDEV} from "react/jsx-dev-runtime"; import {useContext} from "react"; export function Chart({context}) {return jsx("figure", {children:useContext(context)});} export function DevChart({context}) {return jsxDEV("figure", {children:useContext(context)}, undefined, false, {fileName:"plugin.tsx",lineNumber:1,columnNumber:1});}' : null;
      if (bytes === null) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", path === "/" ? "text/html" : "text/javascript"); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  await writeFile(join(scratch, "main.cjs"), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, "profile"))});app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await win.loadURL(${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)});const result=await win.webContents.executeJavaScript('new Promise(resolve=>{function check(){if(window.__streamSmoke)resolve(window.__streamSmoke);else requestAnimationFrame(check);}check();})');console.log('STREAM_SMOKE '+JSON.stringify(result));app.exit(result.ok?0:1);}catch(error){console.error(error);app.exit(1);}});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(scratch, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("exit", done); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  const result = JSON.parse(output.split("\n").find(line => line.startsWith("STREAM_SMOKE ")).slice("STREAM_SMOKE ".length));
  assert.equal(result.ok, true);
  console.log("PASS streaming plugin fence lifecycle", JSON.stringify(result));
} finally {
  if (server) await new Promise(done => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}
