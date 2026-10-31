#!/usr/bin/env node
/** Offline Electron regression for inline GenUI interaction and isolation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const directory = await mkdtemp(join(tmpdir(), "pi-genui-e2e-"));
let child;
let timeout;
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/gen-ui-renderer.tsx")],
    outfile: join(directory, "renderer.js"),
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
    alias: {
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: [join(root, "scripts/e2e/gen-ui-main.mjs")],
    outfile: join(directory, "main.cjs"),
    bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "error",
    alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const assets = join(renderer, "assets");
  const sheets = (await readdir(assets)).filter((name) => name.endsWith(".css"));
  assert.ok(sheets.length, "Build the desktop renderer before running GenUI E2E");
  await writeFile(join(directory, "stylesheet.css"),
    (await Promise.all(sheets.map((name) => readFile(join(assets, name), "utf8")))).join("\n"));
  const html = await readFile(join(root, "apps/desktop/index.html"), "utf8");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(csp, "Production parent CSP not found");
  // The app scrolls its transcript, not the document. This standalone fixture
  // uses document scrolling to exercise the same IntersectionObserver lifecycle.
  await writeFile(join(directory, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="stylesheet.css"><style>html,body{height:auto!important;overflow:auto!important}body{margin:0;padding:20px}#root{max-width:600px;height:auto!important;min-height:0!important;overflow:visible!important}#footer{height:5000px}</style><div id="root"></div><div id="footer"></div><script src="renderer.js"></script>`);
  const home = join(directory, "home");
  await mkdir(home);
  const env = { ...process.env, HOME: home, PI_GEN_UI_E2E_ROOT: root, PI_GEN_UI_E2E_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [join(directory, "main.cjs")], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(signal, null, `GenUI Electron process hung: ${stderr.slice(-4000)}`);
  assert.equal(code, 0, `GenUI Electron process failed: ${stderr.slice(-4000)}`);
  const result = stdout.split("\n").find((line) => line.startsWith("GENUI_E2E "));
  assert.ok(result, `No GenUI result: ${stdout}\n${stderr.slice(-4000)}`);
  assert.equal(JSON.parse(result.slice("GENUI_E2E ".length)).ok, true);
  console.log(result);
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
