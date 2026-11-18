#!/usr/bin/env node
// Synthetic Electron renderer exercise; no installed profile, provider or network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-side-composer-"));
try {
  const styles = await Promise.all(["tokens", "base", "chat-shell", "ui-kit", "composer", "composer-menus", "composer-autocomplete", "work-panel"].map(name =>
    readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")));
  styles.push(await readFile(join(root, "apps/desktop/src/features/side-questions/side-questions.css"), "utf8"));
  await writeFile(join(temp, "style.css"), styles.join("\n"));
  await build({ entryPoints: [join(root, "scripts/e2e/side-question-composer.tsx")], outfile: join(temp, "renderer.js"),
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false}' },
    loader: { ".css": "empty", ".png": "dataurl" },
    alias: { react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{ name: "worklet-url", setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "fixture-url" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, () => ({ contents: 'export default "fixture-worklet"', loader: "js" }));
    } }],
  });
  await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="style.css"><body><script src="renderer.js"></script>');
  await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1600,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 try{await win.loadFile(path.join(__dirname,'index.html'));const result=await win.webContents.executeJavaScript('window.sideQuestionProbe()');console.log('SIDE_COMPOSER '+JSON.stringify(result));app.exit(0);}
 catch(error){console.error(error);app.exit(1);}
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, stderr.slice(-8000));
  const line = stdout.split("\n").find(value => value.startsWith("SIDE_COMPOSER "));
  assert.ok(line, "Missing Electron probe result");
  const result = JSON.parse(line.slice("SIDE_COMPOSER ".length));
  assert.ok(result.inputHeight > 0, "The live side editor must occupy layout space");
  assert.ok(result.checks >= 30, "Expected geometry, reference, permission and isolation checks");
  console.log(`Side Composer: ${result.checks} Electron checks passed`);
} finally { await rm(temp, { recursive: true, force: true }); }
