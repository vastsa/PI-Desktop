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
import { ModelConfigPage } from "../../apps/desktop/src/components/settings/ModelConfigPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const check = (value, message) => { if (!value) throw new Error(message); };
const calls = [], toasts = [];
const model = { id: "fixture-chat", contextWindow: 128000, maxTokens: 8192, thinkingLevels: ["off", "high"], defaultThinkingLevel: "off" };
const base = { vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", enabled: true,
  baseUrl: "https://fixture.invalid/v1", apiStyle: "chat_completions", authKind: "api_key", hasSecret: true,
  models: [model], defaultModelId: model.id, supportsReasoning: true, supportedThinkingLevels: ["off", "high"],
  createdAt: "2026-10-25", updatedAt: "2026-10-25" };
let providers = [{ ...base, id: "official", name: "Official service" }];
let settings = { defaultProviderId: "official", defaultModelId: model.id, imageGenerationModels: [] };
const templates = ["api_key", "none", "oauth"].map(authKind => ({ pluginId: "fixture.templates", templateId: authKind,
  providerId: "plugin-template:fixture.templates:" + authKind, pluginName: "Fixture plugin", category: "Fixture templates",
  name: "Fixture " + authKind, authKind, baseUrl: base.baseUrl, apiStyle: base.apiStyle, models: [model] }));
let sequence = 0, releaseCreate, deferCreate = false;
window.piDesktop = { platform: "win32", on() { return () => {}; }, async invoke(channel, input) {
  calls.push({ channel, input });
  const ok = data => ({ ok: true, data });
  if (channel === "pi-desktop/plugin/providerCatalog") return ok(templates);
  if (channel === "pi-desktop/providers/oauth/vendors") return ok({ vendors: [{ vendorId: templates[2].providerId,
    name: "Fixture OAuth", loginLabel: "Fixture plugin", accounts: providers.filter(row => row.authKind === "oauth")
      .map(row => ({ providerId: row.id, connected: true })), isSubscription: false }] });
  if (channel === "pi-desktop/providers/modelCatalogStatus") return ok({ status: { source: "bundled", modelCount: 1 } });
  if (channel === "pi-desktop/providers/list") return ok({ providers });
  if (channel === "pi-desktop/settings/get") return ok(settings);
  if (channel === "pi-desktop/settings/set") { settings = input; return ok(settings); }
  if (channel === "pi-desktop/providers/createFromTemplate") {
    if (deferCreate) await new Promise(resolve => { releaseCreate = resolve; });
    check(Object.keys(input).every(key => ["pluginId", "templateId", "name", "secretValue"].includes(key)), "template transport was submitted");
    const declaration = templates.find(entry => entry.templateId === input.templateId);
    const provider = { ...base, id: "native-account-" + ++sequence, name: input.name || declaration.name,
      authKind: declaration.authKind, hasSecret: !!input.secretValue, ownerPluginId: declaration.pluginId,
      pluginTemplateId: declaration.templateId, pluginTemplateVersion: 1 };
    if (declaration.authKind === "none") { provider.models = []; provider.defaultModelId = undefined; }
    providers = [...providers, provider];
    return ok({ provider });
  }
  if (channel === "pi-desktop/providers/listModels") {
    check(providers.some(row => row.id === input.providerId), "discovery happened before native account save");
    if (input.providerId === "native-account-3") return ok({ source: "remote", models: [{ modelId: "discovered-chat",
      displayName: "Discovered Chat", capabilities: ["text"], contextWindow: 64000, maxTokens: 4096, source: "discovered" }] });
    if (input.source === "refresh") throw new Error("Fixture discovery unavailable; account retained");
    return ok({ models: [], source: "cache" });
  }
  if (channel === "pi-desktop/providers/update") {
    providers = providers.map(row => row.id === input.id ? { ...row, ...input } : row);
    return ok({ provider: providers.find(row => row.id === input.id) });
  }
  if (channel === "pi-desktop/providers/delete") { providers = providers.filter(row => row.id !== input); return ok({ ok: true }); }
  if (channel === "pi-desktop/providers/setSecret") {
    providers = providers.map(row => row.id === input.id ? { ...row, hasSecret: !!input.secretValue } : row);
    return ok({ provider: providers.find(row => row.id === input.id) });
  }
  if (channel === "pi-desktop/providers/testConnection") return ok({ ok: false, message: "Custom adapter connection check is unsupported" });
  if (channel === "pi-desktop/providers/oauth/start") return { ok: false, error: { code: "FIXTURE", message: "Fixture OAuth stopped" } };
  if (channel === "pi-desktop/secrets/has") return ok({ exists: false });
  throw new Error("Unexpected fixture IPC " + channel);
} };
useAppStore.setState({ providers, settings, showToast(message) { toasts.push(message); },
  async refreshProviders() { useAppStore.setState({ providers }); } });
const rootNode = createRoot(document.getElementById("root"));
const mount = element => flushSync(() => rootNode.render(element));
const frame = () => new Promise(requestAnimationFrame);
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 150; attempt++) { await frame(); const value = predicate(); if (value) return value; }
  throw new Error(message + " / " + document.body.innerText.slice(-1500) + " / " + JSON.stringify(toasts));
}
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent.trim() === text || node.getAttribute("aria-label") === text);
const row = id => document.querySelector('[data-provider-id="' + id + '"]');
const click = node => { check(node, "missing click target"); flushSync(() => node.click()); };
function setValue(input, value) {
  check(input, "missing input");
  flushSync(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function openChooser() {
  click(button("Add provider"));
  await waitFor(() => document.querySelector('[data-plugin-provider-id="' + templates[0].providerId + '"]'), "template missing from chooser");
  check(document.querySelector('[data-service-id="openai"]'), "official service tile disappeared");
}
async function pickTemplate(kind) {
  await openChooser();
  click(document.querySelector('[data-plugin-provider-id="plugin-template:fixture.templates:' + kind + '"]'));
  await waitFor(() => document.querySelector('[role="dialog"]')?.textContent.includes("Fixture plugin"), "source plugin not displayed");
  check(document.documentElement.textContent.includes("fixture.invalid/v1"), "template endpoint not displayed");
}
async function menu(id, label) {
  click(row(id).querySelector('.capability-row-menu-trigger, [aria-haspopup="menu"]'));
  click(await waitFor(() => button(label), "missing menu action " + label));
}
window.templateProbe = async () => {
  mount(React.createElement(ModelConfigPage));
  await waitFor(() => row("official"), "official native row missing");
  await pickTemplate("api_key");
  setValue(document.querySelector('input[type="password"]'), "cancelled-fixture-key");
  click(button("Cancel"));
  check(!calls.some(call => call.channel.endsWith("/createFromTemplate")), "cancel created an account");
  // Two creates from one persistent chooser entry, with explicit duplicate-click protection.
  for (let index = 1; index <= 2; index++) {
    await pickTemplate("api_key");
    setValue(document.querySelector('input[type="password"]'), "fixture-key-" + index);
    const save = button("Save provider");
    flushSync(() => { save.click(); save.click(); });
    await waitFor(() => row("native-account-" + index), "saved account did not reach native list");
    await waitFor(() => toasts.some(text => text.includes("Fixture discovery unavailable")), "discovery failure was hidden");
    check(providers.length === index + 1, "duplicate create or failed discovery removed saved row");
    click(button("Cancel"));
  }
  click(row("native-account-1"));
  await waitFor(() => button("Advanced"), "native account did not open model editor");
  check(document.querySelector('input[type="password"]'), "template key editing missing");
  setValue(document.querySelector('input[type="password"]'), "rotated-fixture-key");
  click(button("Advanced"));
  setValue(document.querySelector(".provider-chosen-field input"), "Account-specific alias");
  const delegation = [...document.querySelectorAll("label")].find(node => node.textContent.includes("Available for AI delegation"))?.querySelector("input");
  check(delegation, "native delegation control missing");
  if (!delegation.checked) click(delegation);
  const image = document.querySelector('input[aria-label="Set as image model"]');
  check(image, "native image-use control missing");
  click(image);
  click(button("Save provider"));
  await waitFor(() => !document.querySelector('[role="dialog"]'), "editor did not save");
  check(providers.find(entry => entry.id === "native-account-1").models[0].alias === "Account-specific alias", "alias not persisted");
  check(providers.find(entry => entry.id === "native-account-2").models[0].alias === undefined, "second account settings changed");
  check(providers.find(entry => entry.id === "native-account-1").models[0].availableForSubagents, "delegation preference not saved");
  check(settings.imageGenerationModels.some(entry => entry.providerId === "native-account-1"), "image-use preference not saved");
  await menu("native-account-1", "Test connection");
  await waitFor(() => toasts.some(text => text.includes("unsupported")), "unsupported connection check was reported as success");
  click(row("native-account-1").querySelector('[role="switch"]'));
  await waitFor(() => !providers.find(entry => entry.id === "native-account-1").enabled, "template toggle did not save");
  await menu("native-account-1", "Delete");
  click(await waitFor(() => button("Click again to delete"), "delete confirmation missing"));
  await waitFor(() => !row("native-account-1"), "deleted account remains");
  check(row("native-account-2") && row("official"), "delete removed another account or official service");
  await pickTemplate("none");
  check(!document.querySelector('input[type="password"]'), "no-auth template asks for key");
  click(button("Save provider"));
  await waitFor(() => row("native-account-3"), "no-auth template did not create");
  const discovered = await waitFor(() => [...document.querySelectorAll('.provider-models-row label')]
    .find(node => node.textContent.includes("Discovered Chat"))?.querySelector('input'), "saved no-auth account did not discover models");
  click(discovered);
  click(button("Save provider"));
  await waitFor(() => !document.querySelector('[role="dialog"]'), "discovered model did not save");
  check(providers.find(entry => entry.id === "native-account-3").models[0].id === "discovered-chat", "discovered model missing from native row");
  // Reauthentication targets the native account ID, never the chooser key.
  providers = [...providers, { ...base, id: "oauth-native-account", name: "OAuth instance", ownerPluginId: "fixture.templates",
    pluginTemplateId: "oauth", pluginTemplateVersion: 1, authKind: "oauth", hasOauth: true }];
  useAppStore.setState({ providers });
  click(await waitFor(() => row("oauth-native-account"), "OAuth account missing"));
  click(await waitFor(() => button("Sign in to OAuth instance"), "OAuth reauthentication missing"));
  await waitFor(() => calls.some(call => call.channel.endsWith("/oauth/start") && call.input === "oauth-native-account"), "OAuth reauth used template key");
  mount(null);
  mount(React.createElement(ModelConfigPage));
  await openChooser();
  const oauthTile = document.querySelector('[data-subscription-vendor-id="' + templates[2].providerId + '"]');
  click(oauthTile);
  await waitFor(() => calls.some(call => call.channel.endsWith("/oauth/start") && call.input === templates[2].providerId), "new OAuth account did not use template key");
  mount(null);
  mount(React.createElement(ModelConfigPage));
  await pickTemplate("api_key");
  setValue(document.querySelector('input[type="password"]'), "stale-fixture-key");
  deferCreate = true;
  click(button("Save provider"));
  await waitFor(() => releaseCreate, "deferred create did not start");
  mount(null);
  releaseCreate();
  await waitFor(() => providers.some(entry => entry.id === "native-account-4"), "in-flight saved account lost");
  await frame();
  check(!document.querySelector('[role="dialog"]'), "unmounted create reopened editor");
  check(calls.filter(call => call.channel.endsWith("/createFromTemplate")).length === 4, "duplicate saves occurred");
  check(calls.filter(call => call.channel.endsWith("/listModels")).every(call => call.input.providerId && !call.input.apiKey), "raw credentials used for discovery");
  return { created: 4, nativeAccountsIndependent: true, officialPreserved: true, discoveryFailureRetainedAccount: true };
};
`;

test("template chooser creates independent native accounts and retains its entry after edit/delete", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron test needs a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "provider-template-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx", sourcefile: "provider-template.jsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      }, nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'none\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.log(event.message));
  win.webContents.on("render-process-gone", (_event, details) => { console.error(JSON.stringify(details)); app.exit(2); });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("TEMPLATE_RESULT " + JSON.stringify(await win.webContents.executeJavaScript("window.templateProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", chunk => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-7000));
    const line = output.split(/\r?\n/).find(value => value.startsWith("TEMPLATE_RESULT "));
    assert(line, output.slice(-7000));
    assert.deepEqual(JSON.parse(line.slice("TEMPLATE_RESULT ".length)), {
      created: 4, nativeAccountsIndependent: true, officialPreserved: true, discoveryFailureRetainedAccount: true,
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
