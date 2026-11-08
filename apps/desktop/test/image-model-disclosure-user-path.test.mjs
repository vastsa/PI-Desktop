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

test("image-model marking explains chat exclusion and remains visible when Advanced is collapsed", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-image-model-disclosure-"));
  try {
    await build({
      stdin: { resolveDir: root, loader: "tsx", contents: `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { ModelSelectionPanes } from "./apps/desktop/src/components/settings/ModelSelectionPanes";
import { composerModelsForProvider } from "./apps/desktop/src/lib/composer-models";
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
const bindings = [{ id: "custom-chat", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [] }];
let selected = [];
function Fixture() {
  const [images, setImages] = useState([]);
  return <ModelSelectionPanes listTitle="Fixture models" discovery={{ status: "ready", models: [] }}
    selection={{ rows: [], models: bindings, publishedLevelsById: new Map(), bindingsToPersist: bindings, setModels() {} }}
    imageModelIds={images} onImageModelChange={(id, checked) => { selected = checked ? [id] : []; setImages(selected); }} />;
}
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<I18nextProvider i18n={i18n}><Fixture /></I18nextProvider>));
const assert = (value, message) => { if (!value) throw new Error(message); };
const advanced = () => document.querySelector(".provider-chosen-advanced-toggle");
const click = (node) => flushSync(() => node.click());
const row = () => document.querySelector(".provider-chosen-row-head");
click(advanced());
const hint = i18n.t("settings.imageModelChatExclusionHint");
assert(document.querySelector('[aria-label="' + hint + '"]'), "Missing explanation before marking");
assert(hint.includes("chat") && hint.includes("image input"), "Explanation must distinguish generation from input");
click(document.querySelector('[aria-label="' + i18n.t("settings.setImageModel") + '"]'));
click(advanced());
assert(row().textContent.includes(i18n.t("settings.imageModelSelected")), "Collapsed row must disclose the image role");
const provider = { id: "fixture", models: bindings };
assert(composerModelsForProvider(provider, [], selected.map(modelId => ({ providerId: provider.id, modelId }))).length === 0, "Saved marking must exclude chat");
click(advanced());
click(document.querySelector('input[aria-label="' + i18n.t("settings.imageModelSelected") + '"]'));
assert(!row().textContent.includes(i18n.t("settings.imageModelSelected")), "Unmark must remove the badge");
assert(composerModelsForProvider(provider, [], []).length === 1, "Unmark restores chat eligibility");
window.probe = { ok: true, hint, selected };
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
  try { await win.loadFile(path.join(__dirname, "index.html")); console.log("IMAGE_MODEL " + JSON.stringify(await win.webContents.executeJavaScript("window.probe"))); app.exit(0); }
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
    assert.match(output, /IMAGE_MODEL {"ok":true/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
