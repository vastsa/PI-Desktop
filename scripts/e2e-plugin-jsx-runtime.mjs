#!/usr/bin/env node
/** Activate automatic JSX through the real host import map in isolated Electron. */
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
const scratch = await mkdtemp(join(tmpdir(), "pi-plugin-jsx-"));
const require = createRequire(join(root, "package.json"));
let server;
try {
  await build({ stdin: { contents: 'export {installRendererImportMap, REACT_IMPORT_MAP} from "./apps/desktop/src/plugins/renderer-host/import-map.ts"; export * as React from "react"; export {createRoot} from "react-dom/client";', resolveDir: root, loader: "ts" }, outfile: join(scratch, "host.mjs"), bundle: true, format: "esm", platform: "browser", define: { "process.env.NODE_ENV": '"production"' } });
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import {installRendererImportMap, REACT_IMPORT_MAP, React, createRoot} from '/host.mjs';
try {
  installRendererImportMap();
  const plugin = await import('/plugin.mjs');
  const Context = React.createContext('missing');
  const rootView = createRoot(document.querySelector('#root'));
  rootView.render(React.createElement(React.Fragment,null,
    React.createElement(Context.Provider,{value:'Production JSX'},React.createElement(plugin.Chart,{context:Context})),
    React.createElement(Context.Provider,{value:'Development JSX'},React.createElement(plugin.DevChart,{context:Context}))));
  await new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();const figures=[...document.querySelectorAll('figure')].map(node=>node.textContent);reject(new Error('automatic JSX plugins did not render: '+JSON.stringify({figures,html:document.querySelector('#root')?.innerHTML})));},10000);
    function check(){const figures=[...document.querySelectorAll('figure')].map(node=>node.textContent);if(figures[0]==='Production JSX'&&figures[1]==='Development JSX'){clearTimeout(timer);observer.disconnect();resolve();}}
    observer.observe(document.body,{childList:true,subtree:true});check();
  });
  window.__jsxSmoke={ok:true,text:[...document.querySelectorAll('figure')].map(node=>node.textContent),imports:Object.keys(REACT_IMPORT_MAP)};
  rootView.unmount();
}catch(error){window.__jsxSmoke={ok:false,error:error.stack};}
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
  await writeFile(join(scratch, "main.cjs"), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, "profile"))});app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await win.loadURL(${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)});const result=await win.webContents.executeJavaScript('new Promise(resolve=>{function check(){if(window.__jsxSmoke)resolve(window.__jsxSmoke);else requestAnimationFrame(check);}check();})');console.log('JSX_SMOKE '+JSON.stringify(result));app.exit(result.ok?0:1);}catch(error){console.error(error);app.exit(1);}});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(scratch, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("exit", done); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  const result = JSON.parse(output.split("\n").find(line => line.startsWith("JSX_SMOKE ")).slice("JSX_SMOKE ".length));
  assert.equal(result.ok, true);
  console.log("PASS production and development JSX plugin activation with host hooks and context", JSON.stringify(result));
} finally {
  if (server) await new Promise(done => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}
