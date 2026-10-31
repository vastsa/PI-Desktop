import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");

const fixture = String.raw`
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { PluginViewTab } from "./src/components/workpanel/PluginViewTab";

const calls = [];
window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async (channel, ...args) => {
    calls.push({ channel, args });
    return { ok: true, data: undefined };
  },
  on: () => () => undefined,
};

document.body.style.cssText = "margin:0;display:flex;align-items:flex-start";
const sidebar = document.createElement("div");
sidebar.style.cssText = "flex:0 0 0;height:240px";
const host = document.createElement("div");
host.style.cssText = "flex:0 0 320px;width:320px;height:240px";
const style = document.createElement("style");
style.textContent = ".work-plugin-view,.work-plugin-view-surface{width:100%;height:100%}";
document.head.append(style);
document.body.append(sidebar, host);

const i18n = createInstance();
const ready = i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
  interpolation: { escapeValue: false },
});
const root = createRoot(host);
const view = () => (
  <I18nextProvider i18n={i18n}>
    <PluginViewTab pluginId="fixture.plugin" viewId="surface" title="Fixture" />
  </I18nextProvider>
);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const boundsCalls = () => calls
  .filter((entry) => entry.channel === IPC.invoke.pluginViewSetBounds)
  .map((entry) => entry.args[0]);
const settledBounds = async () => {
  let previousCount = -1;
  for (let frame = 0; frame < 8; frame += 1) {
    await nextFrame();
    const current = boundsCalls();
    if (current.length > 0 && current.length === previousCount) return current.at(-1);
    previousCount = current.length;
  }
  return undefined;
};

globalThis.pluginViewBoundsProbe = async () => {
  await ready;
  flushSync(() => root.render(view()));
  const initial = await settledBounds();
  if (!initial) throw new Error("plugin view did not report initial bounds");

  calls.length = 0;
  host.style.transform = "translateX(180px)";
  let churnFrame = 0;
  const churn = () => {
    churnFrame = requestAnimationFrame(churn);
    flushSync(() => root.render(view()));
  };
  churnFrame = requestAnimationFrame(churn);
  flushSync(() => root.render(view()));
  const moved = await settledBounds();
  cancelAnimationFrame(churnFrame);
  const surface = document.querySelector(".work-plugin-view-surface").getBoundingClientRect();
  if (!moved) throw new Error("plugin view bounds were starved by repeated layout commits");
  if (Math.round(moved.x) !== Math.round(surface.x)) {
    throw new Error("reported x does not match the moved surface: " + JSON.stringify({ moved, x: surface.x }));
  }
  if (Math.round(initial.width) !== Math.round(moved.width)) {
    throw new Error("fixture changed surface width: " + JSON.stringify({ initial, moved }));
  }
  return { initial, moved };
};
`;

test(
  "plugin native bounds follow position-only renderer layout changes",
  {
    skip:
      process.platform === "linux" && !process.env.DISPLAY
        ? "Electron requires a display"
        : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-plugin-view-bounds-"));
    try {
      await build({
        stdin: {
          contents: fixture,
          resolveDir: join(root, "apps/desktop"),
          loader: "tsx",
        },
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        loader: { ".css": "empty" },
        alias: {
          "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
          "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
      });
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><body><script src="renderer.js"></script>',
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
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.pluginViewBoundsProbe()");
    console.log("PLUGIN_VIEW_BOUNDS_PROBE " + JSON.stringify({ ok: true, result }));
    app.exit(0);
  } catch (error) {
    console.error("PLUGIN_VIEW_BOUNDS_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`,
      );

      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        resolveElectronBinary(root).electronBinary,
        [join(temp, "main.cjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
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

      const line = output
        .split(/\r?\n/)
        .find((item) => item.startsWith("PLUGIN_VIEW_BOUNDS_PROBE "));
      assert.ok(line, output.slice(-6000));
      assert.equal(code, 0, output.slice(-6000));
      const report = JSON.parse(line.slice("PLUGIN_VIEW_BOUNDS_PROBE ".length));
      assert.equal(report.ok, true, output.slice(-6000));
      assert.equal(report.result.initial.x, 0);
      assert.equal(report.result.moved.x, 180);
      assert.equal(report.result.initial.width, report.result.moved.width);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
