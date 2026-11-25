import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const desktop = join(root, "apps/desktop");
const run = promisify(execFile);

const inspectSidebar = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const body = document.querySelector(".sidebar-body");
  const recent = document.querySelector(".sidebar-session-group-body.standalone");
  const pinned = document.querySelector(".sidebar-session-group-body.pinned");
  const projects = document.querySelector(".sidebar-session-groups");
  const pointFor = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return element.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  };
  return {
    viewport: innerHeight,
    pinned: pinned.clientHeight,
    recent: recent.clientHeight,
    recentCount: recent.querySelectorAll("[data-sidebar-session-row]").length,
    projectHeight: projects.clientHeight,
    project: pointFor('.sidebar-session-groups [data-sidebar-session-row="session-1"] .thread-item-main'),
    settings: pointFor('[data-nav="settings"]'),
    outerOverflow: body.scrollHeight - body.clientHeight,
    outerScroll: getComputedStyle(body).overflowY,
  };
};

test("sidebar keeps project sessions and Settings reachable after loading more and zooming", {
  skip: process.platform === "linux" && !process.env.DISPLAY && "Electron requires a display",
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-sidebar-height-"));
  try {
    await build({
      configFile: false,
      root: desktop,
      base: "./",
      logLevel: "error",
      plugins: [tailwindcss()],
      esbuild: { jsx: "automatic" },
      resolve: {
        alias: [
          { find: /^@pi-desktop\/shared$/, replacement: join(root, "packages/shared/src/index.ts") },
          { find: /^@pi-desktop\/i18n$/, replacement: join(root, "packages/i18n/src/index.ts") },
        ],
      },
      build: {
        outDir: temp,
        target: "esnext",
        cssCodeSplit: false,
        rollupOptions: {
          input: join(desktop, "test/fixtures/sidebar-height.tsx"),
          output: {
            format: "iife",
            inlineDynamicImports: true,
            entryFileNames: "sidebar.js",
            assetFileNames: "assets/[name][extname]",
          },
        },
      },
    });
    await writeFile(join(temp, "index.html"), `<!doctype html>
      <html lang="en" data-platform="${process.platform}"><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
      <link rel="stylesheet" href="assets/style.css"><div id="root"></div><script defer src="sidebar.js"></script>`);
    await writeFile(join(temp, "main.cjs"), `
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1040, height: 720, useContentSize: true,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const evaluate = (code) => wc.executeJavaScript(code);
  const inspect = () => evaluate(${JSON.stringify(`(${inspectSidebar})()`)});
  await win.loadFile(join(__dirname, "index.html"));
  await evaluate("window.sidebarProbe.then(() => true)");
  assert.equal((await inspect()).recentCount, 7);
  await evaluate(${JSON.stringify('document.querySelector(\'[data-action="recent-sessions-load-more"]\').click()')});
  const loaded = await inspect();
  assert.equal(loaded.recentCount, 17);
  assert.ok(loaded.project, JSON.stringify(loaded));

  const compactZoom = win.getContentSize()[1] / 490;
  wc.setZoomFactor(compactZoom);
  const compact = await inspect();
  assert.ok(Math.abs(compact.viewport - 490) <= 1, JSON.stringify(compact));
  assert.equal(compact.recentCount, 17);
  assert.ok(compact.project, "Project row clipped: " + JSON.stringify(compact));
  assert.ok(compact.recent < loaded.recent, JSON.stringify(compact));
  assert.ok(compact.settings, JSON.stringify(compact));
  const point = {
    x: Math.round(compact.project.x * wc.getZoomFactor()),
    y: Math.round(compact.project.y * wc.getZoomFactor()),
    button: "left", clickCount: 1,
  };
  wc.sendInputEvent({ type: "mouseDown", ...point });
  wc.sendInputEvent({ type: "mouseUp", ...point });
  await inspect();
  assert.deepEqual(await evaluate("window.sidebarProbe.then(({ calls }) => calls)"), ["session-1"]);
  console.log(JSON.stringify({ compactViewport: compact.viewport, recentHeight: compact.recent, projectHeight: compact.projectHeight }));

  wc.setZoomFactor(3);
  const extreme = await inspect();
  assert.ok(extreme.outerOverflow > 0);
  assert.equal(extreme.outerScroll, "auto");
  await evaluate("document.querySelector('[data-nav=settings]').scrollIntoView()");
  assert.ok((await inspect()).settings);
  await evaluate("document.querySelector('.sidebar-session-groups').scrollIntoView()");
  assert.ok((await inspect()).project);

  wc.setZoomFactor(1);
  const restored = await inspect();
  assert.equal(restored.recentCount, loaded.recentCount);
  assert.equal(restored.recent, loaded.recent);
  assert.ok(restored.project);

  await evaluate("window.sidebarProbe.then((probe) => probe.showMorePins())");
  const roomyPins = await inspect();
  wc.setZoomFactor(compactZoom);
  const compactPins = await inspect();
  assert.ok(compactPins.pinned < roomyPins.pinned, JSON.stringify(compactPins));
  assert.ok(compactPins.project, JSON.stringify(compactPins));
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await run(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, timeout: 30_000,
    });
    t.diagnostic(stdout.trim());
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
