/** Mounted production dialog regression tests in isolated Electron/Chromium.
 * Only the preload host boundary is stubbed; components, store, i18n and CSS are real.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { repositoryRoot, resolveElectronBinary, assertDesktopBuild } from "./e2e/boot.mjs";

const root = repositoryRoot();
assertDesktopBuild(root);
const { build } = createRequire(new URL("../packages/agent-runtime/package.json", import.meta.url))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-dialog-layout-"));
const artifacts = process.env.PI_DIALOG_ARTIFACT_DIR ? resolve(process.env.PI_DIALOG_ARTIFACT_DIR) : temp;
await mkdir(artifacts, { recursive: true });
const assets = join(root, "apps/desktop/out/renderer/assets");
const stylesheet = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
if (!stylesheet) throw new Error("Built renderer stylesheet missing");
await build({ entryPoints: [join(root, "apps/desktop/test/fixtures/dialog-overflow.jsx")],
  outfile: join(temp, "fixture.js"), bundle: true, format: "esm", platform: "browser", jsx: "automatic",
  define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' } });
const server = createServer(async (req, res) => {
  try {
    const name = req.url?.split("?")[0];
    if (name === "/") {
      res.setHeader("content-type", "text/html");
      res.end(`<html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/${stylesheet}"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
      return;
    }
    const file = name === "/fixture.js" ? join(temp, "fixture.js") : resolve(assets, (name ?? "").replace(/^\/assets\//, ""));
    if (file !== join(temp, "fixture.js") && !file.startsWith(assets + "/") && !file.startsWith(assets + "\\")) { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const url = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env, PI_DIALOG_FIXTURE_URL: url, PI_DIALOG_ARTIFACT_DIR: artifacts }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(resolveElectronBinary(root).electronBinary, [`--user-data-dir=${join(temp, "profile")}`, join(root, "apps/desktop/test/fixtures/dialog-overflow-runner.cjs")], { env, windowsHide: true, stdio: "inherit" });
  const code = await new Promise((resolvePromise, reject) => { child.on("exit", resolvePromise); child.on("error", reject); });
  process.exitCode = code ?? 1;
} finally {
  server.closeAllConnections(); await new Promise((resolvePromise) => server.close(resolvePromise));
  if (artifacts !== temp) await rm(temp, { recursive: true, force: true });
}
