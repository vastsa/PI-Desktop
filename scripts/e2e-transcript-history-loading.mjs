#!/usr/bin/env node
/** Native wheel + production ChatTranscript, isolated synthetic history only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const manual = process.argv.includes("--manual");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? root, "history-loading-"));
try {
  await build({ entryPoints: [join(root, "scripts/e2e/transcript-history-loading.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ DEV: false, MODE: "production" }) },
    loader: { ".css": "empty" }, alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")], plugins: [{ name: "assets", setup(b) {
      b.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: join(resolveDir, path.slice(0, -4)), namespace: "asset" }));
      b.onLoad({ filter: /.*/, namespace: "asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
    } }],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map(m => m[1]);
  assert(css.length, "Build Desktop before running this test");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:"><title>History loading scroll regression</title>${css.map(p => `<link rel="stylesheet" href="${p}">`).join("")}<script type="module" src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show: true, width: 1100, height: 720, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
 win.webContents.on('console-message', e => console.error(e.message));
 const js = expression => win.webContents.executeJavaScript(expression);
 const call = expression => js('globalThis.historyLoadingFixture.' + expression);
 const wheel = async (point, deltaY) => {
   win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
   win.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, deltaY, deltaX: 0, canScroll: true });
   await call('frames()');
 };
  win.focus();
 try {
  await win.loadFile(require('node:path').join(__dirname, 'index.html'));
  await js('new Promise((resolve,reject)=>{const end=performance.now()+10000;const check=()=>{if(globalThis.historyLoadingFixture)resolve();else if(performance.now()>end)reject(new Error("fixture did not initialize"));else requestAnimationFrame(check)};check()})');
  console.log('HISTORY_MOTION ' + await js('JSON.stringify({ reduced: matchMedia("(prefers-reduced-motion: reduce)").matches })'));
  if (${manual}) return;
  const results = [];
  for (const name of ['wheel', 'quiet', 'tail', 'late-layout', 'failure', 'empty', 'hide']) {
   await call('reset()');
   const before = await call('begin()');
   if (name === 'wheel') assert.deepEqual(await call('inputOwnership()'),
     { wheel: true, key: true, touch: true, field: false, activation: false, nested: false, zoom: false });
   if (name === 'wheel') for (let n = 0; n < 6; n++) await wheel(before, n % 2 ? 80 : -240);
   if (name === 'tail') await call('growTail()');
   const during = await call('inspect()');
   const after = await call(name === 'hide' ? 'hideAndReveal()' : 'release(' + (name === 'failure') + ',' + (name === 'late-layout') + ',' + (name === 'empty') + ')');
   const result = { name, before, during, after };
   results.push(result);
   console.log('HISTORY_LOADING_CASE ' + JSON.stringify(result));
   assert(Math.abs(during.offset - before.offset) <= 2, name + ': loading input/layout moved the visible row');
   assert(after.maxDrift <= 2, name + ': a painted frame moved the reading anchor by ' + after.maxDrift);
   assert(Math.abs(after.offset - before.offset) <= 2, name + ': page changed the reading position');
   assert.equal(after.calls, 1, name + ': duplicate page request');
   assert.equal(after.locked, false, name + ': input remained blocked');
   for (let n = 0; n < 4; n++) await wheel(after, -120);
   const free = await call('inspect()');
   assert(Math.abs(free.top - after.top) > 2 || free.calls > after.calls, name + ': scrolling/retry remained locked after completion');
  }
  let crossingError;
  try {
    await call('reset()');
    const crossing = await call('crossAhead()');
    assert.equal(crossing.locked, false, 'crossing the ahead band locked input');
    await call('release(false,false,true)');
    console.log('HISTORY_AHEAD_CROSSING ' + JSON.stringify({ ok: true }));
  } catch (error) { crossingError = error; console.log('HISTORY_AHEAD_CROSSING_ERROR ' + String(error)); }
  await call('reset()');
  await call('beginAhead()');
  await call('frames()');
  const ahead = await call('inspect()');
  assert.equal(ahead.locked, false, 'ahead-loading blocked main input');
  await call('armNativeInput()');
  await wheel(ahead, 180);
  const moved = await call('finishNativeInput()');
  console.log('HISTORY_AHEAD_INPUT ' + JSON.stringify({ ahead, moved }));
  assert(moved.offset > ahead.offset + 20, 'native wheel could not move text while ahead-loading');
  assert.equal(moved.calls, 1, 'native wheel duplicated the pending read');
  await call('track()');
  const aheadAfter = await call('release(false,true)');
  assert(aheadAfter.maxDrift <= 2, 'ahead-loaded prepend moved the new reading point');
  assert.equal(aheadAfter.locked, false, 'ahead-loading left input blocked');
  console.log('HISTORY_AHEAD_NATIVE ' + JSON.stringify({ ahead, moved, after: aheadAfter }));
  await call('reset()'); await call('begin()'); await call('release()');
  const cached = await call('growMountedWindow()');
  assert(cached.after.maxDrift <= 2 && Math.abs(cached.after.offset - cached.before.offset) <= 2,
    'mounting cached history moved the reading anchor');
  assert.equal(cached.after.calls, 1, 'cached window growth made another page request');
  assert.equal(cached.after.locked, false, 'cached window growth left input blocked');
  await call('reset()');
  await call('begin()');
  const navigation = await call('jumpWhileLoading()');
  assert.equal(navigation.locked, false, 'return-to-latest did not cancel the old hold');
  assert(Math.abs(navigation.distanceFromBottom) <= 2, 'late page stole explicit latest navigation');
  const realNavigation = await js('globalThis.transcriptHistoryNavigationProbe()');
  console.log('REAL_HISTORY_NAVIGATION_PROBE ' + JSON.stringify(realNavigation));
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reduced = await js('globalThis.transcriptHistoryNavigationProbe(true)');
    console.log('LATEST_REDUCED_MOTION ' + JSON.stringify(reduced));
  } finally { win.webContents.debugger.detach(); }
  assert.equal(crossingError, undefined, 'ahead-loading interrupted browser smooth scroll');
  console.log('HISTORY_LOADING_PROBE ' + JSON.stringify({ ok: true, cases: results.length, cachedWindow: true, inputOwnership: true, latestNavigation: true }));
  app.exit(0);
 } catch(e) { console.error(e.stack || String(e)); app.exit(1); }
});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; process.stdout.write(data); });
  const timer = manual ? undefined : setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output.slice(-6000));
  if (!manual) assert.match(output, /HISTORY_LOADING_PROBE .*"ok":true/);
} finally { await rm(temp, { recursive: true, force: true }); }
