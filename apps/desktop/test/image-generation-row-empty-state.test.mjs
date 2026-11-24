/**
 * The image model picker row must stay visible when nothing can be picked.
 *
 * The built-in GenerateImages error sends the user to
 * Settings > Models > Image generation model (#2563). The row used to vanish
 * entirely while no image-capable model existed, turning that pointer into a
 * dead end; this pins that an empty candidate list still renders the row with
 * an explicit "nothing available" state, and that a real candidate still gets
 * the normal picker.
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

test("image model row stays visible without candidates and picks normally with them", {
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
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
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
function Fixture({ settings }) {
  return <ImageGenerationModelRow settings={settings} providers={[provider, other]} onChange={() => {}} />;
}
const root = createRoot(document.getElementById("root"));
const render = (settings) => flushSync(() => root.render(
  <I18nextProvider i18n={i18n}><Fixture settings={settings} /></I18nextProvider>));
const emptySettings = { imageGenerationModels: [], imageGeneration: null };
render(emptySettings);
const row = () => document.querySelector(".model-image-row");
assert(row(), "Row must render with no image candidates");
assert(row().textContent.includes(i18n.t("settings.imageModel")), "Row title must name the setting");
assert(
  row().textContent.includes(i18n.t("settings.imageModelNoneAvailable")),
  "Empty state must explain that no image model is available",
);
const withCandidate = {
  imageGenerationModels: [{ providerId: "prov", modelId: "img-model" }, { providerId: "other", modelId: "img-two" }],
  imageGeneration: { providerId: "prov", modelId: "img-model" },
};
render(withCandidate);
assert(row(), "Row must render with a candidate");
assert(
  row().textContent.includes("Prov") && row().textContent.includes("img-model"),
  "Row must show the configured provider and model",
);
assert(document.querySelector(".model-image-selector"), "Picker must appear for a runnable candidate");
window.probe = { ok: true };
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
  try { await win.loadFile(path.join(__dirname, "index.html")); console.log("IMAGE_ROW " + JSON.stringify(await win.webContents.executeJavaScript("window.probe"))); app.exit(0); }
  catch (error) { console.error(error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
    const timeout = setTimeout(() => child.kill(), 30_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timeout); }
    assert.equal(code, 0, output);
    assert.match(output, /IMAGE_ROW {"ok":true/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
