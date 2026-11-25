/**
 * The image model picker row must stay visible when nothing can be picked.
 *
 * The built-in GenerateImages error sends the user to
 * Settings > Models > Image generation model (#2563). The row used to vanish
 * entirely while no image-capable model existed, turning that pointer into a
 * a dead end. Cover an empty list, a list with no runnable candidate, and
 * the normal picker when candidates are runnable.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("image model row stays visible when empty or unavailable and keeps working when runnable", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-image-row-empty-"));
  try {
    await build({
      stdin: { resolveDir: root, loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { ImageGenerationModelRow } from "./apps/desktop/src/components/settings/ImageGenerationModelRow";
const provider = {
  id: "prov", name: "Prov", enabled: true, hasSecret: true, hasOauth: false,
  authKind: "api_key_and_base_url", baseUrl: "https://example.test",
  models: [{ id: "img-model" }],
};
const other = {
  id: "other", name: "Other", enabled: true, hasSecret: true, hasOauth: false,
  authKind: "api_key_and_base_url", baseUrl: "https://other.test",
  models: [{ id: "img-two" }],
};
function Fixture({ settings, providers }) {
  return <ImageGenerationModelRow settings={settings} providers={providers} onChange={() => {}} />;
}
window.imageRowProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const root = createRoot(document.getElementById("root"));
  const render = (settings, providers) => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}><Fixture settings={settings} providers={providers} /></I18nextProvider>));
  const row = () => document.querySelector(".model-image-row");
  const picker = () => row()?.querySelector(".model-image-selector");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const checkStatus = (key) => {
    check(row()?.querySelector(".model-default-label")?.textContent === i18n.t("settings.imageModel"),
      "The row must keep its settings label: " + key);
    check(row()?.querySelector('[role="status"]')?.textContent === i18n.t(key),
      "Expected image model status: " + key);
    check(!picker(), "Picker must be absent with no runnable candidates");
  };

  render({ imageGenerationModels: [], imageGeneration: null }, [provider, other]);
  checkStatus("settings.imageModelNoneAvailable");

  const configured = {
    imageGenerationModels: [{ providerId: "prov", modelId: "img-model" }, { providerId: "other", modelId: "img-two" }],
    imageGeneration: { providerId: "prov", modelId: "img-model" },
  };
  const unavailable = [{ ...provider, enabled: false }, { ...other, hasSecret: false }];
  render(configured, unavailable);
  checkStatus("settings.imageModelUnavailable");
  render({ ...configured, imageGeneration: null }, unavailable);
  checkStatus("settings.imageModelUnavailable");

  render(configured, [provider, other]);
  check(row()?.querySelector(".model-default-provider")?.textContent === "Prov" &&
    row()?.querySelector(".model-default-model")?.textContent === "img-model",
    "Row must show the configured provider and model");
  check(picker(), "Picker must appear when multiple candidates are runnable");
  return { ok: true };
};
` },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src") },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try { await win.loadFile(path.join(__dirname, "index.html")); console.log("IMAGE_ROW " + JSON.stringify(await win.webContents.executeJavaScript("window.imageRowProbe()"))); app.exit(0); }
  catch (error) { console.error(error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (data) => { output += data; });
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timeout); }
    assert.equal(timedOut, false, `Image row Electron probe timed out:\n${output}`);
    assert.equal(code, 0, output);
    assert.match(output, /IMAGE_ROW {"ok":true/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
