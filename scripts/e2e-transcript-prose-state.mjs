#!/usr/bin/env node
/** Real Markdown state must survive transcript content recycling. No providers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
assert(process.env.PI_SCRATCH_DIR, "Set an isolated scratch directory");
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "prose-state-"));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
try {
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {TranscriptProse} from './apps/desktop/src/features/chat/transcript/TranscriptProse';
const table='Name | Value\\n--- | ---\\nA | B';
const diagram='\u0060\u0060\u0060mermaid\\ngraph TD; A-->B\\n\u0060\u0060\u0060';
const texts=[table,diagram,'Ordinary **paragraph** with inline code.'];
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const frames=async()=>{for(let i=0;i<8;i++)await frame()};
const check=(value,message)=>{if(!value)throw Error(message)};
const until=async(test,label)=>{const end=performance.now()+20000;while(!test()){if(performance.now()>end)throw Error(label);await frame()}};
window.proseProbe=async()=>{
 await i18n.use(initReactI18next).init({lng:'en',resources:{en:{translation:{}}}});
 flushSync(()=>createRoot(document.getElementById('root')).render(<>{texts.map((source,index)=><section className='thread-scroll' data-case={index} key={index}><div className='spacer'/><TranscriptProse source={source} streaming={false}/><div style={{height:9000}}/></section>)}</>));
 await until(()=>document.querySelector('.mermaid-action-btn[aria-pressed]'),'Mermaid did not render');
 document.querySelector('.mermaid-action-btn[aria-pressed]').click();
 await frames();
 document.querySelector('.markdown-table button:last-child').click();
 await frames();
 const dialog=document.querySelector('.markdown-table-preview');
 check(dialog,'Table preview must open');
 check(!document.querySelector('[data-case="0"] .prose-chat').contains(document.activeElement),'Preview focus must be portalled outside prose');
 for(const viewport of document.querySelectorAll('.thread-scroll')){viewport.querySelector('.spacer').style.height='8000px';viewport.dispatchEvent(new Event('scroll'))}
 await frames();
 check(dialog.isConnected,'Offscreen recycling closed an open table preview');
 check(document.querySelector('.mermaid-action-btn[aria-pressed="true"]'),'Offscreen recycling reset Mermaid source state');
 check(document.querySelector('[data-case="2"] [data-transcript-content="placeholder"]'),'Ordinary prose must still recycle');
 for(const viewport of document.querySelectorAll('.thread-scroll')){viewport.querySelector('.spacer').style.height='0px';viewport.dispatchEvent(new Event('scroll'))}
 await frames();
 check(dialog.isConnected,'Returning to content lost table preview');
 check(document.querySelector('.mermaid-action-btn[aria-pressed="true"]'),'Returning to content lost Mermaid state');
 check(document.querySelector('[data-case="2"] [data-transcript-content="mounted"]'),'Ordinary prose must remount');
 return {tablePreview:true,mermaidState:true,ordinaryProseRecycled:true};
};
` }, outfile: join(directory, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
    loader: { ".css": "empty" }, alias: { react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")], plugins: [{ name: "assets", setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: join(resolveDir, path.slice(0, -4)), namespace: "asset" }));
      builder.onLoad({ filter: /.*/, namespace: "asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
    } }],
  });
  await writeFile(join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\' data:; img-src \'self\' data:"><style>.thread-scroll{height:220px;overflow:auto;overflow-anchor:none}.markdown-table-overlay{position:fixed;inset:0}</style><div id="root"></div><script type="module" src="renderer.js"></script>');
  await writeFile(join(directory, "main.cjs"), `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.disableHardwareAcceleration();
const watchdog=setTimeout(()=>{console.error('PROSE_STATE timeout');app.exit(1)},45000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,width:1000,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 try{
  await win.loadFile(require('node:path').join(__dirname,'index.html'));
  const result=await win.webContents.executeJavaScript('globalThis.proseProbe()');
  console.log('PROSE_STATE '+JSON.stringify(result));clearTimeout(watchdog);app.exit(0);
 }catch(error){console.error(String(error));clearTimeout(watchdog);app.exit(1)}
});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(directory, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  console.log(output);
  assert.equal(code, 0, "Real Markdown state regression failed");
  assert.match(output, /"ordinaryProseRecycled":true/);
} finally { await rm(directory, { recursive: true, force: true }); }
