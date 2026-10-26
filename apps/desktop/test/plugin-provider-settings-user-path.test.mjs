import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ServiceList } from "../../apps/desktop/src/components/settings/ServiceList";
import { PluginProviderSettingsDialog } from "../../apps/desktop/src/components/settings/PluginProviderSettingsDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const calls = [];
let provider = {
  id: "plugin:fixture.models:chat", name: "Plugin service", vendorKey: "custom",
  type: "openai_compatible", protocol: "openai_compatible", enabled: true,
  baseUrl: "https://fixture.invalid/v1", authKind: "api_key", hasSecret: true,
  ownerPluginId: "fixture.models", supportsReasoning: false, supportedThinkingLevels: [],
  models: [{ id: "fixture-chat", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: null }],
  createdAt: "2026-10-25", updatedAt: "2026-10-25",
};
let imageIds = [];
let saved = 0;
let closed = 0;
let toggled = 0;
window.piDesktop = { platform: "win32", on() { return () => {}; }, async invoke(channel, input) {
  calls.push({ channel, input });
  if (channel === "pi-desktop/providers/listModels") {
    if (input.providerId !== provider.id) throw new Error("wrong provider");
    return { ok: true, data: { models: [], source: "cache" } };
  }
  if (channel === "pi-desktop/providers/update") {
    if (Object.keys(input).some((key) => !["id", "name", "models"].includes(key))) throw new Error("transport or secret submitted");
    provider = { ...provider, name: input.name, models: input.models };
    return { ok: true, data: { provider } };
  }
  throw new Error("Unexpected fixture IPC " + channel);
} };
useAppStore.setState({ providers: [provider] });
const rootNode = createRoot(document.getElementById("root"));
const mount = (element) => flushSync(() => rootNode.render(element));
const frame = () => new Promise(requestAnimationFrame);
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt++) { await frame(); const value = predicate(); if (value) return value; }
  throw new Error(message);
}
function check(value, message) { if (!value) throw new Error(message); }
function button(text) { return [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text); }
function setValue(input, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function openEditor() {
  mount(React.createElement(PluginProviderSettingsDialog, { provider, imageModelIds: imageIds,
    onClose() { closed++; mount(null); },
    async onSaved(next, models, images) { provider = next; imageIds = images; saved++; mount(null); },
  }));
}
function openList() {
  mount(React.createElement(ServiceList, { providers: [provider], accountFor: () => null, busy: false,
    isRowBusy: () => false, testingId: null, onEdit: openEditor, onTest() {}, onCopy() {}, onRemove() {},
    onToggleEnabled() { toggled++; }, async onSaveKey() { throw new Error("model edit opened key entry"); },
  }));
}
window.pluginProviderSettingsProbe = async () => {
  for (const authKind of ["api_key", "none", "oauth"]) {
    provider = { ...provider, authKind };
    openList();
    const row = document.querySelector(".model-provider-row");
    check(row, "provider row missing");
    const toggle = row.querySelector('[role="switch"]');
    check(toggle && !toggle.disabled, "plugin user enablement is locked");
    flushSync(() => toggle.click());
    flushSync(() => row.click());
    await waitFor(() => document.querySelector('[role="dialog"]'), "plugin row did not open model editor");
    check(!document.querySelector('input[type="password"]'), "model editor exposed a credential field");
    check(!document.querySelector('input[value="https://fixture.invalid/v1"]'), "endpoint became editable");
    flushSync(() => button("Advanced").click());
    const alias = document.querySelector(".provider-chosen-field input");
    check(alias, "model alias field missing");
    flushSync(() => setValue(alias, "Configured " + authKind));
    const subagentLabel = [...document.querySelectorAll("label")].find((node) => node.textContent.includes("Available for AI delegation"));
    check(subagentLabel?.querySelector('input[type="checkbox"]'), "subagent opt-in missing");
    const subagent = subagentLabel.querySelector("input");
    if (!subagent.checked) flushSync(() => subagent.click());
    const imageChoice = document.querySelector('input[aria-label="Set as image model"]');
    if (imageChoice) flushSync(() => imageChoice.click());
    flushSync(() => button("Save provider").click());
    await waitFor(() => saved > ["api_key", "none", "oauth"].indexOf(authKind), "model settings not saved");
    check(provider.models[0].alias === "Configured " + authKind, "alias was lost on save");
    check(provider.models[0].availableForSubagents === true, "subagent opt-in was lost");
    check(imageIds[0] === "fixture-chat", "image use preference was lost");
    check(provider.models[0].supportsImages === undefined, "image use changed image-input capability");
    openEditor();
    await waitFor(() => button("Advanced"), "editor did not reopen");
    flushSync(() => button("Advanced").click());
    check(document.querySelector(".provider-chosen-field input").value === "Configured " + authKind, "saved alias not restored");
    flushSync(() => setValue(document.querySelector(".provider-chosen-field input"), "Unsaved"));
    const savedImageChoice = document.querySelector('input[aria-label="Selected image model"]');
    check(savedImageChoice?.checked, "image preference not restored");
    flushSync(() => savedImageChoice.click());
    flushSync(() => button("Cancel").click());
    check(provider.models[0].alias !== "Unsaved", "cancel persisted a draft");
    check(imageIds[0] === "fixture-chat", "cancel changed image-use preferences");
  }
  imageIds = [];
  provider = { ...provider, hasOauth: true, pluginModelOperations: { "fixture-chat": ["chat"] } };
  openEditor();
  await waitFor(() => button("Advanced"), "OAuth operation editor missing");
  flushSync(() => button("Advanced").click());
  check(!document.querySelector('input[aria-label="Set as image model"]'), "chat-only adapter offered generation");
  flushSync(() => button("Cancel").click());
  provider = { ...provider, pluginModelOperations: { "fixture-chat": ["images"] } };
  openEditor();
  await waitFor(() => button("Advanced"), "image adapter editor missing");
  flushSync(() => button("Advanced").click());
  check(document.querySelector('input[aria-label="Set as image model"]'), "OAuth image operation missing");
  const imageDelegate = [...document.querySelectorAll("label")].find(node => node.textContent.includes("Available for AI delegation"));
  check(imageDelegate.querySelector("input").disabled, "image-only adapter offered chat delegation");
  flushSync(() => button("Cancel").click());
  provider = { ...provider, pluginModelOperations: undefined };
  openEditor();
  await waitFor(() => document.querySelector('[aria-label="Remove model"]'), "model remove control missing");
  flushSync(() => document.querySelector('[aria-label="Remove model"]').click());
  flushSync(() => button("Save provider").click());
  await waitFor(() => saved === 4, "empty model selection did not save");
  check(provider.models.length === 0 && imageIds.length === 0, "removed model retained its image-use preference");
  check(calls.filter((call) => call.channel.endsWith("/update")).length === 4, "duplicate model settings write");
  check(calls.filter((call) => call.channel.endsWith("/listModels")).every((call) => call.input.source === "cache"), "opening editor triggered network discovery");
  return { saved, closed, toggled, credentialAndTransportFieldsExcluded: true, cancelPreservesSettings: true };
};
`;

test("plugin services edit model settings across credential kinds without changing transport or secrets", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron test needs a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-model-settings-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx", sourcefile: "plugin-provider-settings.jsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      }, nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("PLUGIN_SETTINGS_RESULT " + JSON.stringify(await win.webContents.executeJavaScript("window.pluginProviderSettingsProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((value) => value.startsWith("PLUGIN_SETTINGS_RESULT "));
    assert(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("PLUGIN_SETTINGS_RESULT ".length)), {
      saved: 4, closed: 5, toggled: 3, credentialAndTransportFieldsExcluded: true, cancelPreservesSettings: true,
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
