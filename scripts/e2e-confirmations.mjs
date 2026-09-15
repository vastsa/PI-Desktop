#!/usr/bin/env node
/** Real Electron renderer interaction for the session deletion modal. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-confirmation-"));
try {
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import i18n from 'i18next';
        import {initReactI18next} from 'react-i18next';
        import {en} from '@pi-desktop/i18n';
        import {SessionDeleteDialog} from './src/components/SessionDeleteDialog';
        await i18n.use(initReactI18next).init({lng:'en', resources:{en:{translation:en}}});
        const root = createRoot(document.getElementById('root'));
        window.calls=0; window.errors=0; window.dismissCount=0;
        window.openDialog=()=>root.render(<SessionDeleteDialog session={{id:'fixture',title:'Important session'}}
          onClose={()=>{window.dismissCount++; root.render(null);}}
          onDelete={()=>{window.calls++; return new Promise((resolve,reject)=>{window.resolveDelete=resolve;window.rejectDelete=reject;});}}
          onError={()=>{window.errors++;}} />);
        window.openDialog();
      `,
      resolveDir: join(root, "apps/desktop"), loader: "tsx",
    },
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser",
    format: "esm", jsx: "automatic",
  });
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="renderer.js"></script>');
  await writeFile(join(temp, "main.cjs"), `
    const {app,BrowserWindow}=require('electron');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
      win.webContents.on("console-message", (event) => console.log(event.message));
      try {
        await win.loadFile(${JSON.stringify(join(temp, "index.html"))});
        const result=await win.webContents.executeJavaScript(\`(async()=>{
          const wait=()=>new Promise(r=>setTimeout(r,40));
          const check=(condition,message)=>{if(!condition)throw new Error(message);};
          const buttons=()=>[...document.querySelectorAll('button')];
          const cancel=()=>buttons().find(b=>b.textContent==='Cancel');
          const destroy=()=>buttons().find(b=>b.textContent==='Permanently delete');
          for(let i=0;i<100&&!cancel();i++)await wait();
          check(document.body.textContent.includes('Important session'),'session title: '+document.body.innerHTML);
          check(document.body.textContent.includes('cannot be undone'),'irreversible warning');
          for(let i=0;i<25&&document.activeElement!==cancel();i++)await wait();
          check(document.activeElement===cancel(),'Cancel receives default focus');
          cancel().click();await wait();check(calls===0&&dismissCount===1,'cancel preserves data');
          openDialog();await wait();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await wait();
          check(calls===0&&dismissCount===2,'Escape preserves data');
          openDialog();await wait();document.querySelector('.overlay').click();await wait();
          check(calls===0&&dismissCount===3,'backdrop preserves data');
          openDialog();await wait();destroy().click();destroy()?.click();await wait();
          check(calls===1,'single pending deletion');
          check(buttons().every(b=>b.disabled),'pending actions disabled');
          window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await wait();
          check(dismissCount===3,'pending deletion cannot be dismissed');
          rejectDelete(new Error('fixture failure'));await wait();
          check(errors===1&&document.querySelector('[role=dialog]'),'failure keeps dialog');
          destroy().click();await wait();check(calls===2,'failure permits retry');
          resolveDelete();await wait();
          return {ok:true,checks:10};
        })()\`);
        console.log('CONFIRMATION_PROBE '+JSON.stringify(result));app.exit(0);
      }catch(error){console.error(error);app.exit(1);}
    });
  `);
  const { electronBinary } = resolveElectronBinary(root);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /CONFIRMATION_PROBE .*"ok":true/);
  console.log("PASS session deletion modal: focus, cancel, Escape, backdrop, duplicate submission, error and retry");
} finally {
  await rm(temp, { recursive: true, force: true });
}
