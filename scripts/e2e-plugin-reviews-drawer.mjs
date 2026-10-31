#!/usr/bin/env node
// Real review-drawer components and Chromium behaviour; only host APIs are
// fixtures. Drives the public user path: card chip -> detail summary ->
// drawer (paging/dedup, filter stale-drop, error+retry) -> write link ->
// Tab trap/inert -> Escape with focus and scroll restoration.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));

/**
 * Electron's download is shared with the host checkout: prefer the worktree's
 * own linked install, otherwise resolve the hoisted package. Dependency
 * linking itself is owned by the environment setup, not by this script.
 */
function resolveElectronBinary() {
  const localDir = join(desktop, "node_modules", "electron");
  const localPathFile = join(localDir, "path.txt");
  const fallbackDir = dirname(require.resolve("electron"));
  const electronDir = existsSync(localPathFile) ? localDir : fallbackDir;
  const relativeBinary = existsSync(join(electronDir, "path.txt"))
    ? readFileSync(join(electronDir, "path.txt"), "utf8").trim()
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const binary = join(electronDir, "dist", relativeBinary);
  if (!existsSync(binary)) throw new Error("Electron binary missing: " + binary);
  return binary;
}

const cache = join(root, ".cache/plugin-reviews-drawer");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "run-"));
await require("esbuild").build({
  entryPoints: [join(root, "scripts/e2e/plugin-reviews-drawer.tsx")],
  outfile: join(temp, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty" },
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  // `render-diagnostics.ts` reads `import.meta.env`; the iife bundle cannot
  // carry it and the probe does not depend on it.
  logOverride: { "empty-import-meta": "silent" },
  // The browser packages resolve through the checkout's node_modules; the
  // workspace packages must come from THIS worktree's built sources, not a
  // possibly older copy under the host install.
  alias: {
    "@pi-desktop/shared": join(root, "packages/shared/dist/index.js"),
    "@pi-desktop/plugin-sdk": join(root, "packages/plugin-sdk/dist/index.js"),
  },
});
// The real stylesheets that lay this surface out (tokens, the app-shell base,
// the shared kit, and the plugins page) are inlined, so scroll containment and
// geometry match the shipping cascade without a full renderer build. Entrance
// animations are disabled exactly as the repo's reduced-motion tail does: a
// hidden window does not advance them, and geometry must be measured settled.
await writeFile(
  join(temp, "index.html"),
  `<!doctype html><html><head><style>${readFileSync(
    join(desktop, "src/styles/tokens.css"),
    "utf8",
  )}\n${readFileSync(join(desktop, "src/styles/base.css"), "utf8")}\n${readFileSync(
    join(desktop, "src/styles/ui-kit.css"),
    "utf8",
  )}\n${readFileSync(
    join(desktop, "src/styles/plugins.css"),
    "utf8",
  )}\n.plugins-reviews,.plugins-reviews-scrim,.plugins-sheet,.plugins-sheet-scrim,.plugins-menu,.plugins-modal,.plugins-modal-backdrop{animation:none !important;}
</style></head><body><script src="renderer.js"></script></body></html>`,
);
await writeFile(
  join(temp, "main.cjs"),
  `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  try {
    const win=new BrowserWindow({show:false,useContentSize:true,width:900,height:720,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true}});
    await win.loadFile(require('node:path').join(__dirname,'index.html'));
    const probes=['pluginReviewsDrawerProbe','pluginReviewsStaleSummaryProbe','pluginReviewsUnavailableSummaryProbe','pluginReviewsBatchProbe','pluginReviewsNarrowDrawerProbe'];
    let failed=false;
    for(const name of probes){
      // The narrow probe runs against a phone-sized viewport; everything else
      // keeps the desktop one.
      win.setContentSize(name==='pluginReviewsNarrowDrawerProbe'?320:900,name==='pluginReviewsNarrowDrawerProbe'?720:720);
      const guarded='(async()=>{try{const value=await Promise.race([globalThis.'+name+'(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("probe timeout")),45000))]);return {ok:true,value:value};}catch(error){return {ok:false,message:(error&&error.message)||String(error),step:globalThis.__probeStep||"unknown"};}})()';
      const outcome=await win.webContents.executeJavaScript(guarded);
      if(outcome&&outcome.ok){
        console.log(outcome.value);
      } else {
        failed=true;
        console.error(name+': '+((outcome&&outcome.message)||'unknown failure')+' (step: '+((outcome&&outcome.step)||'unknown')+')');
      }
    }
    app.exit(failed?1:0);
  } catch(error) { console.error(error); app.exit(1); }
});`,
);
const result = spawnSync(resolveElectronBinary(), [join(temp, "main.cjs")], {
  stdio: "inherit",
  timeout: 60000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
