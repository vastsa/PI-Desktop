#!/usr/bin/env node
/**
 * Renderer-level geometry regression for #1762.
 *
 * The maintainer's review on #1769 asked for proof that the active tab's close
 * control sits inside the strip viewport and receives pointer hits — after a
 * narrow panel, after a resize that keeps the same active tab, and on hover of
 * a partially visible inactive tab. Source-contract tests cannot show any of
 * that, so this runs the real WorkPanel in Electron and measures.
 *
 * Cross-platform: DOM geometry + elementFromPoint. Native Win32 hit testing
 * for drag regions remains in scripts/e2e-work-panel-drag.mjs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-tab-close-"));

try {
  const styles = await Promise.all(
    ["tokens", "base", "chat-shell", "ui-kit", "work-panel"].map((name) =>
      readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8"),
    ),
  );
  await writeFile(join(temp, "style.css"), styles.join("\n"));

  await build({
    entryPoints: [join(root, "scripts/e2e/work-panel-tab-close.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    alias: {
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
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>PI Tab Close Regression</title><link rel="stylesheet" href="style.css"><body><script src="renderer.js"></script>',
  );

  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    for (const stage of ["narrow-active", "resize-same-tab", "hover-inactive", "context-menu-user-path", "plugin-view-menu-layer"]) {
      const result = await win.webContents.executeJavaScript(
        "window.tabCloseProbe(" + JSON.stringify(stage) + ")");
      console.log("TAB_CLOSE " + JSON.stringify(result));
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`,
  );

  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) {
    console.error(stderr);
    assert.fail("electron probe failed with exit code " + code);
  }

  const results = stdout
    .split("\n")
    .filter((line) => line.startsWith("TAB_CLOSE "))
    .map((line) => JSON.parse(line.slice("TAB_CLOSE ".length)));
  assert.equal(results.length, 5, "expected geometry, tab-menu, and plugin-layer stages");

  for (const result of results) {
    if (result.stage === "context-menu-user-path") {
      assert.equal(result.passed, true, "tab context-menu user path failed");
      assert.equal(result.remainingTabs, 0, "Close All Tabs did not empty the strip");
      assert.equal(result.activeTabId, null, "Close All Tabs retained an active tab");
      console.log("context menu user path: PASS");
      continue;
    }
    if (result.stage === "plugin-view-menu-layer") {
      assert.equal(result.nativeMenuRequested, true, "Browser tab did not request the native menu");
      assert.equal(result.pageRemainsVisibleWhileMenuOpen, true, "Browser page disappeared while the menu was open");
      assert.equal(result.pageRemainsVisibleAfterMenuClose, true, "Browser page disappeared after menu close");
      console.log("native menu preserves Browser page: PASS");
      continue;
    }
    console.log(
      `${result.stage}: strip [${result.stripLeft.toFixed(1)}, ${result.stripRight.toFixed(1)}] ` +
        `clientWidth=${result.stripClientWidth} ` +
        `close [${result.closeLeft.toFixed(1)}, ${result.closeRight.toFixed(1)}] ` +
        `inside=${result.insideStrip} hit=${result.hitIsClose || result.hitIsDescendant}`,
    );
    assert.ok(
      result.insideStrip,
      `${result.stage}: close control escapes the strip viewport`,
    );
    assert.ok(
      result.hitIsClose || result.hitIsDescendant,
      `${result.stage}: close control is not the pointer hit target`,
    );
  }
  console.log("tab close geometry: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}
