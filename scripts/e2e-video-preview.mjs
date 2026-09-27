#!/usr/bin/env node
/** Real React/Chromium coverage for the local video preview, playback, seeking and native-save boundary. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-video-preview-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/video-preview-ui.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      // The fixture lives outside the desktop package; use its React instance.
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await mkdir(join(temp, "scratch"));
  await copyFile(join(root, "apps/desktop/resources/skills/ai-aggregation-platform/tests/fixtures/clip.mp4"), join(temp, "scratch/海 洋.mp4"));
  // Use the production CSP, not a permissive test-only policy.
  const html = await readFile(join(root, "apps/desktop/out/renderer/index.html"), "utf8");
  const csp = html.match(/content="(default-src[^\"]+)"/)[1];
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="renderer.css"><body><script src="renderer.js"></script>`);
  await build({ entryPoints: [join(root, "scripts/e2e/video-preview-main.ts")], outfile: join(temp, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"] });
  await writeFile(join(temp, "preload.cjs"), `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('piDesktop', { invoke: (channel, input) => ipcRenderer.invoke(channel, input), on: () => () => {} });`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output.split(/\r?\n/).find((line) => line.startsWith("VIDEO_PREVIEW_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-2000)}`);
  const result = JSON.parse(line.slice("VIDEO_PREVIEW_PROBE ".length));
  console.log("VIDEO_PREVIEW_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
