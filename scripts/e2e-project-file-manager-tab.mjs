#!/usr/bin/env node
/**
 * #2607 — the bundled file manager is one live view shared by a project, so
 * every session of that project must carry a real file-manager tab without the
 * user opening one, while a session that closed it locally keeps it closed.
 *
 * Runs the real production WorkPanel, app store, launcher rows and tab strip in
 * Electron and walks the user path: A opens the file manager from its launcher
 * row, B (which had Review selected and the panel collapsed) comes back with
 * both tabs, closing it locally in B is final, and a fresh session C already
 * has it — while a session in another project never does.
 *
 * Only `window.piDesktop` is inert here; guest-page behaviour and
 * WebContentsView composition stay with scripts/e2e-file-manager-lines.mjs.
 *
 * Prerequisite: `apps/desktop/node_modules` + `packages/agent-runtime/node_modules`
 * (electron, esbuild) shared with the primary checkout. No install, no build
 * step, and a throwaway profile — it never touches a real user profile.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-tab-"));
const MARKER = "FILE_MANAGER_TAB_E2E ";

try {
  // The panel's own stylesheet decides tab and launcher geometry; the shared
  // token/base sheets keep its variables resolvable.
  const styles = await Promise.all(
    ["tokens", "base", "chat-shell", "ui-kit", "work-panel"].map((name) =>
      readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8"),
    ),
  );
  await writeFile(join(temp, "style.css"), styles.join("\n"));

  await build({
    entryPoints: [join(root, "scripts/e2e/project-file-manager-tab.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"test","DEV":false}' },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/plugin-sdk": join(root, "packages/plugin-sdk/src/index.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });

  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>File manager tab regression</title><link rel="stylesheet" href="style.css"><body><script src="renderer.js"></script>',
  );

  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.fileManagerProjectTabProbe()");
    console.log(${JSON.stringify(MARKER)} + JSON.stringify(result));
    app.exit(result?.ok === true ? 0 : 1);
  } catch (error) {
    console.error(${JSON.stringify(MARKER)} + JSON.stringify({ ok: false, error: String(error?.stack || error) }));
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
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output += data;
    });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }

  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(MARKER));
  assert(line, `probe returned no result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice(MARKER.length));
  assert.equal(
    result.ok,
    true,
    `file manager tab assertions failed: ${result.error ?? "unknown failure"}\n${output.slice(-2000)}`,
  );
  assert.equal(code, 0, output.slice(-6000));
  console.log(line);
  for (const check of result.checks ?? []) console.log("  PASS " + check);
  console.log("file manager project tab: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}
