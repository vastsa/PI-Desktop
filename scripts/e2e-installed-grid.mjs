#!/usr/bin/env node
// Real installed-grid components and Chromium behaviour; only host APIs are
// fixtures. Drives the installed user path: groups and counts, control-rail
// order and gating (scope first, update OR panel, disabled none), the detail
// disclosure, the real compact scope menu, chip-in-meta and long-id
// truncation, the 340px grid floor with the sub-340 fallback, narrow rail
// wrapping, and the action path update -> permission review -> marketInstall,
// open-panel id, settings sheet, and the overflow auto-update/uninstall
// controls. Nothing installs outside the renderer.
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

const cache = join(root, ".cache/installed-grid");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "run-"));
await require("esbuild").build({
  entryPoints: [join(root, "scripts/e2e/installed-grid.tsx")],
  outfile: join(temp, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty" },
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  // `render-diagnostics.ts` reads `import.meta.env`; the iife probe does not.
  logOverride: { "empty-import-meta": "silent" },
  // The browser packages resolve through the checkout's node_modules; the
  // workspace packages must come from THIS worktree's built sources, not a
  // possibly older copy under the host install.
  alias: {
    "@pi-desktop/shared": join(root, "packages/shared/dist/index.js"),
    "@pi-desktop/plugin-sdk": join(root, "packages/plugin-sdk/dist/index.js"),
  },
});
// The real stylesheets that lay these surfaces out (tokens, the app-shell
// base, the shared kit, the plugins page, and the extension scope controls)
// are inlined, so geometry and scroll containment match the shipping cascade
// without a full renderer build. Entrance animations are disabled exactly as
// the repo's reduced-motion tail does: a hidden window does not advance them.
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
  )}\n${readFileSync(
    join(desktop, "src/styles/extensions.css"),
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
    const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true}});
    await win.loadFile(require('node:path').join(__dirname,'index.html'));
    const probes=['installedGridLayoutProbe','installedGridActionsProbe'];
    let failed=false;
    for(const name of probes){
      const guarded='(async()=>{try{const value=await Promise.race([globalThis.'+name+'(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("probe timeout")),40000))]);return {ok:true,value:value};}catch(error){return {ok:false,message:(error&&error.message)||String(error),step:globalThis.__probeStep||"unknown"};}})()';
      const result=await win.webContents.executeJavaScript(guarded);
      if(result&&result.ok){
        console.log(result.value);
      } else {
        failed=true;
        console.error(name+': '+((result&&result.message)||'unknown failure')+' (step: '+((result&&result.step)||'unknown')+')');
      }
    }
    app.exit(failed?1:0);
  } catch(error) { console.error(error); app.exit(1); }
});`,
);
const result = spawnSync(resolveElectronBinary(), [join(temp, "main.cjs")], {
  stdio: "inherit",
  timeout: 90000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
