import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

test("the account picker restores the automatic default, switches the same model to another group on selection and signs out", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "star-ai-onboarding-"));
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./fixtures/star-ai-onboarding.tsx", import.meta.url))],
      outfile: join(dir, "renderer.js"), platform: "browser", format: "iife", bundle: true,
      jsx: "automatic",
      plugins: [{
        name: "vite-asset-url",
        setup(bundler) {
          bundler.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "asset-url" }));
          bundler.onLoad({ filter: /.*/, namespace: "asset-url" }, ({ path }) => ({
            contents: "export default " + JSON.stringify(path.slice(0, -4)),
          }));
        },
      }],
      define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(join(dir, "index.html"), '<meta charset="utf-8"><link rel="stylesheet" href="./renderer.css"><div id="root"></div><script src="./renderer.js"></script>');
    await writeFile(join(dir, "main.cjs"), `
      const {app, BrowserWindow} = require("electron");
      app.setPath("userData", require("node:path").join(__dirname, "profile"));
      app.whenReady().then(async () => {
        const win = new BrowserWindow({show:false, webPreferences:{backgroundThrottling:false, sandbox:true}});
        await win.loadFile(require("node:path").join(__dirname, "index.html"));
        const result = await win.webContents.executeJavaScript("window.probe()");
        console.log("STARAI_PROBE " + JSON.stringify(result));
        app.exit(0);
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(resolveElectronBinary().electronBinary, [join(dir, "main.cjs")], {
      env, timeout: 45000,
    });
    const result = stdout.split("\n").find(line => line.startsWith("STARAI_PROBE "));
    assert.deepEqual(JSON.parse(result.slice("STARAI_PROBE ".length)), [
      "login", { group: "gpt ultra fast", model: "gpt-4o" }, "logout",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
