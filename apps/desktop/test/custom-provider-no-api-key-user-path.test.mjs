/** Configure a custom OpenAI-compatible endpoint that does not require a key. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ProviderSetupDialog } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const calls = [];
let createdProvider = null;
let updatedProvider = null;
let updateInput = null;
let savedCallback = false;
window.addEventListener("error", (event) => {
  console.error("CUSTOM_PROVIDER_NO_KEY_WINDOW_ERROR", event.error?.stack ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("CUSTOM_PROVIDER_NO_KEY_REJECTION", event.reason?.stack ?? event.reason);
});

window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    calls.push({ channel, input });
    if (channel === "pi-desktop/plugin/providerCatalog") {
      return { ok: true, data: [] };
    }
    if (channel === "pi-desktop/providers/listModels") {
      return { ok: true, data: { models: [], source: "remote" } };
    }
    if (channel === "pi-desktop/providers/lookupModel") {
      return { ok: true, data: { info: null } };
    }
    if (channel === "pi-desktop/providers/create") {
      createdProvider = {
        id: "custom:no-auth",
        ...input,
        enabled: true,
        hasSecret: false,
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
      };
      return { ok: true, data: { provider: createdProvider } };
    }
    if (channel === "pi-desktop/providers/update") {
      updateInput = input;
      updatedProvider = {
        ...createdProvider,
        ...input,
        hasSecret: Boolean(input.secretValue) || createdProvider.hasSecret,
      };
      return { ok: true, data: { provider: updatedProvider } };
    }
    throw new Error("Unexpected fixture IPC: " + channel);
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ providers: [] });

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const rootNode = createRoot(document.getElementById("root"));
function mount(element) { flushSync(() => rootNode.render(element)); }

window.customProviderNoApiKeyProbe = async () => {
  mount(React.createElement(ProviderSetupDialog, {
    key: "new-provider",
    provider: null,
    onClose: () => mount(null),
    onSaved: () => { savedCallback = true; },
  }));
  const customTile = await waitFor(
    () => document.querySelector('[data-service-id="custom"]'),
    "the custom endpoint service was not offered",
  );
  flushSync(() => customTile.click());

  const noApiKeyToggle = await waitFor(
    () => document.querySelector('[role="switch"][aria-label="No API key required"]'),
    "the custom endpoint form did not offer its no-key option",
  );
  const noApiKeyDefaultsOff = noApiKeyToggle.getAttribute("aria-checked") === "false";
  const nameField = [...document.querySelectorAll("label")]
    .find((label) => label.textContent.includes("Name"))
    ?.querySelector("input");
  const urlField = document.querySelector('input[type="url"]');
  if (!nameField || !urlField) throw new Error("the custom endpoint identity fields were missing");
  setValue(nameField, "No Auth Gateway");
  setValue(urlField, "https://no-auth.example.org/v1");

  const discoveryCall = await waitFor(
    () => calls.find((call) => call.channel === "pi-desktop/providers/listModels"
      && call.input.baseUrl === "https://no-auth.example.org/v1"),
    "the custom endpoint was not probed without an API key",
  );
  const keyField = document.querySelector('input[type="password"]');
  setValue(keyField, "temporary-api-key");
  flushSync(() => noApiKeyToggle.click());
  const keyFieldDisabled = keyField?.disabled === true;
  const keyFieldCleared = keyField?.value === "";

  const modelField = document.querySelector('input[placeholder^="Enter a model ID"]');
  if (!modelField) throw new Error("the custom model input was missing");
  setValue(modelField, "no-auth-chat");
  const addModelButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Add custom model");
  if (!addModelButton) throw new Error("the custom model add action was missing");
  flushSync(() => addModelButton.click());
  await waitFor(
    () => document.querySelector(".provider-chosen")?.innerText.includes("no-auth-chat"),
    "the model was not added to the custom provider",
  );

  const saveButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Save provider");
  if (!saveButton) throw new Error("the custom provider save action was missing");
  flushSync(() => saveButton.click());
  await waitFor(() => savedCallback && createdProvider, "the custom provider was not saved");
  const savedAsNoAuth = createdProvider.authKind === "none"
    && !Object.hasOwn(createdProvider, "secretValue")
    && createdProvider.models?.[0]?.id === "no-auth-chat";

  let updateSavedCallback = false;
  mount(React.createElement(ProviderSetupDialog, {
    key: "edit-provider",
    provider: createdProvider,
    onClose: () => mount(null),
    onSaved: (provider) => {
      updatedProvider = provider;
      updateSavedCallback = true;
    },
  }));
  const editNoApiKeyToggle = await waitFor(
    () => document.querySelector('[role="switch"][aria-label="No API key required"]'),
    "the saved no-key setting did not reopen",
  );
  const editOpenedAsNoAuth = editNoApiKeyToggle.getAttribute("aria-checked") === "true";
  flushSync(() => editNoApiKeyToggle.click());
  const editKeyField = document.querySelector('input[type="password"]');
  const editKeyEnabled = editKeyField?.disabled === false;
  setValue(editKeyField, "saved-api-key");
  const updateButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Save provider");
  if (!updateButton) throw new Error("the edited custom provider save action was missing");
  flushSync(() => updateButton.click());
  await waitFor(() => updateSavedCallback && updateInput, "the custom provider auth update was not saved");

  return {
    discoveryOmittedApiKey: !Object.hasOwn(discoveryCall.input, "apiKey"),
    noApiKeyDefaultsOff,
    keyFieldDisabled: keyFieldDisabled,
    keyFieldCleared: keyFieldCleared,
    savedAuthKind: savedAsNoAuth ? "none" : createdProvider.authKind,
    secretValueOmitted: savedAsNoAuth,
    selectedModel: createdProvider.models?.[0]?.id,
    editOpenedAsNoAuth,
    editKeyEnabled,
    updateAuthKind: updateInput.authKind,
    updateStoredKey: updateInput.secretValue === "saved-api-key",
  };
};
`;

test("a custom endpoint can be saved and selected without an API key", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.custom-provider-no-api-key-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "custom-provider-no-api-key.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.customProviderNoApiKeyProbe()");
    console.log("CUSTOM_PROVIDER_NO_API_KEY_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/)
      .find((item) => item.startsWith("CUSTOM_PROVIDER_NO_API_KEY_PROBE "));
    assert(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("CUSTOM_PROVIDER_NO_API_KEY_PROBE ".length)), {
      discoveryOmittedApiKey: true,
      noApiKeyDefaultsOff: true,
      keyFieldDisabled: true,
      keyFieldCleared: true,
      savedAuthKind: "none",
      secretValueOmitted: true,
      selectedModel: "no-auth-chat",
      editOpenedAsNoAuth: true,
      editKeyEnabled: true,
      updateAuthKind: "api_key_and_base_url",
      updateStoredKey: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
