#!/usr/bin/env node
/**
 * Real React/Chromium regression for issue #324: toggling a tool, thinking or
 * activity title must not move the transcript the reader is looking at.
 *
 * The fixture mounts the real `useTranscriptScroll` and `useFollowScroll` in a
 * real 600 CSS px scroller with the real `ToolRow` disclosure, and clicks the
 * title with a real DOM click. What it proves is geometry: the clicked title's
 * offset from the scroller's top edge, and the scroll offset, before and after
 * the toggle. The app's stylesheet is not linked, so the heights come from
 * inline filler and the components' own intrinsic size — the height delta is
 * asserted to be large enough to matter, which is what the displacement was.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  join(root, "packages/agent-runtime/package.json"),
);
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-transcript-disclosure-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/transcript-disclosure-anchor.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    // The fixture measures its own geometry, so no app stylesheet is needed.
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Transcript disclosure anchor regression</title><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window still has to deliver ResizeObserver callbacks and
      // animation frames, because that is what the product scroll logic uses.
      backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.transcriptDisclosureProbe()");
    console.log("TRANSCRIPT_DISCLOSURE_PROBE " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("TRANSCRIPT_DISCLOSURE_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`,
  );
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("TRANSCRIPT_DISCLOSURE_PROBE "));
  assert(
    line,
    `renderer returned no probe result (exit=${code}): ${output.slice(-2000)}`,
  );
  const result = JSON.parse(line.slice("TRANSCRIPT_DISCLOSURE_PROBE ".length));
  console.log("TRANSCRIPT_DISCLOSURE_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
