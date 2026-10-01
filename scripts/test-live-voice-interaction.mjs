/** Mounted Live Voice interaction checks, not a full AppShell/provider/device E2E.
 * Production controls, controller, store, shortcuts and i18n; fake external edges only.
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
const temp = await mkdtemp(join(tmpdir(), "pi-live-voice-interaction-"));
const artifacts = process.env.PI_LIVE_VOICE_ARTIFACT_DIR
  ? resolve(process.env.PI_LIVE_VOICE_ARTIFACT_DIR)
  : await mkdtemp(join(tmpdir(), "pi-live-voice-results-"));
let server;
try {
  await mkdir(artifacts, { recursive: true });
  const assets = join(root, "apps/desktop/out/renderer/assets");
  const stylesheet = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
  if (!stylesheet) throw new Error("Built renderer stylesheet missing; reuse the host build environment");
  await build({
    entryPoints: [join(root, "apps/desktop/test/fixtures/live-voice-interaction.jsx")],
    outfile: join(temp, "fixture.js"), bundle: true, format: "esm", platform: "browser", jsx: "automatic",
    // Reused node_modules may link a primary-checkout dist; test candidate sources.
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      "@pi-desktop/voice-runtime/live": join(root, "packages/voice-runtime/src/live/index.ts"),
    },
    define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "live-worklet-url",
      setup(builder) {
        // Keep the production URL import without executing a worklet in the WebRTC fixture.
        builder.onResolve({ filter: /pcm-worklet\.js\?url$/ }, (args) => ({
          path: args.path, namespace: "live-fixture-url",
        }));
        builder.onLoad({ filter: /.*/, namespace: "live-fixture-url" }, () => ({
          contents: 'export default "/pcm-worklet.js";', loader: "js",
        }));
      },
    }],
  });
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/${stylesheet}"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
        return;
      }
      let file;
      if (["/fixture.js", "/fixture.css"].includes(pathname)) file = join(temp, pathname.slice(1));
      else if (pathname === "/pcm-worklet.js") file = join(root, "apps/desktop/src/features/voice/live/pcm-worklet.js");
      else if (pathname.startsWith("/assets/")) {
        file = resolve(assets, decodeURIComponent(pathname.slice("/assets/".length)));
        if (!file.startsWith(assets + "/") && !file.startsWith(assets + "\\")) file = undefined;
      }
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[extname(file)] ?? "application/octet-stream");
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const env = {
    ...process.env,
    PI_LIVE_VOICE_FIXTURE_URL: `http://127.0.0.1:${server.address().port}`,
    PI_LIVE_VOICE_ARTIFACT_DIR: artifacts,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Live Voice mounted interaction artifacts: ${artifacts}`);
  const child = spawn(resolveElectronBinary(root).electronBinary, [
    `--user-data-dir=${join(temp, "profile")}`,
    join(root, "apps/desktop/test/fixtures/live-voice-interaction-runner.cjs"),
  ], { env, windowsHide: true, stdio: "inherit" });
  process.exitCode = await new Promise((resolvePromise, reject) => {
    child.once("exit", (code) => resolvePromise(code ?? 1));
    child.once("error", reject);
  });
} finally {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
  await rm(temp, { recursive: true, force: true });
}
