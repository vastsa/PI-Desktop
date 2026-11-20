/**
 * Real-renderer user path for subagent delegation editor routing (#1758).
 *
 * The unit test pins `serviceEditorTarget` as a pure function; this test clicks
 * the actual Advanced buttons in the rendered page and asserts which dialog the
 * user lands in. A vendor subscription account must open VendorAccountDialog,
 * never ProviderSetupDialog: saving the provider form would rewrite the
 * account's name, endpoint and API style along with the model list.
 *
 * Uses the same isolated-Electron harness as the other `*-user-path` tests.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { IPC } from "@pi-desktop/shared";
import { ModelConfigPage } from "../../apps/desktop/src/components/settings/ModelConfigPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const model = (id, optedIn) => ({
  id,
  contextWindow: 128000,
  maxTokens: 8192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
  availableForSubagents: optedIn,
});

const apiService = {
  id: "api-service",
  name: "API Service",
  vendorKey: "custom",
  enabled: true,
  hasSecret: true,
  hasOauth: false,
  authKind: "api_key_and_base_url",
  models: [model("api-model", true)],
};

const accountService = {
  id: "account-service",
  name: "Vendor Subscription",
  vendorKey: "vendor-subscription",
  enabled: true,
  hasSecret: false,
  authKind: "oauth",
  oauthAccountLabel: "work@example.test",
  models: [model("account-model", true)],
};

const providers = [apiService, accountService];
const settings = {
  defaultMode: "agent",
  theme: "light",
  language: "en",
  developerMode: false,
  defaultProviderId: "api-service",
  defaultModelId: "api-model",
};

const calls = [];
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    calls.push({ channel, input: args[0] });
    switch (channel) {
      case IPC.invoke.providersList:
        return { ok: true, data: { providers } };
      case IPC.invoke.providersOauthVendors:
        return { ok: true, data: { vendors: [] } };
      case IPC.invoke.providersModelCatalogStatus:
        return { ok: true, data: { status: { loaded: false, source: "bundled", catalogPath: "", providerCount: 0, modelCount: 0 } } };
      case IPC.invoke.secretsHas:
        return { ok: true, data: { has: false } };
      case IPC.invoke.settingsGet:
        return { ok: true, data: settings };
      default:
        throw new Error("Unexpected fixture IPC: " + channel);
    }
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ settings, providers });
document.documentElement.dataset.theme = "light";

const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(ModelConfigPage)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}
const dialogs = () => ({
  delegation: document.querySelector(".model-subagent-dialog"),
  account: document.querySelector(".vendor-account-dialog"),
  provider: document.querySelector(".provider-setup-dialog"),
});
const advancedButtons = () => [...document.querySelectorAll(".provider-chosen-advanced-toggle")];
const buttonByText = (label) => [...document.querySelectorAll("button")]
  .find((candidate) => candidate.textContent.trim() === label);

window.delegationRoutingProbe = async () => {
  await waitFor(() => document.querySelector(".model-subagent-row") || buttonByText("Edit"),
    "the subagent delegation summary row did not render");

  // The page keeps the full list behind Edit; open it and read the two rows.
  const edit = buttonByText("Edit");
  if (!edit) throw new Error("the Edit entry point is missing");
  flushSync(() => edit.click());
  await waitFor(() => Boolean(dialogs().delegation), "the delegation dialog did not open");
  const rowCountAtOpen = document.querySelectorAll(".model-subagent-dialog .provider-chosen-row").length;
  const advancedAtOpen = advancedButtons().length;

  // Click Advanced on the API service row: it must reach the provider form.
  // Rows render in provider order, so the first is the API service.
  flushSync(() => advancedButtons()[0].click());
  await waitFor(() => Boolean(dialogs().provider || dialogs().account),
    "clicking Advanced did not open any service editor");
  const apiRoutedToProvider = Boolean(dialogs().provider) && !dialogs().account;
  const delegationClosedForApi = !dialogs().delegation;

  // Close the provider form, reopen the delegation dialog, then route the
  // vendor account: it must reach VendorAccountDialog, not the provider form.
  const providerClose = [...dialogs().provider.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === "Cancel"
      || candidate.getAttribute("aria-label") === "Close"
      || candidate.classList.contains("project-create-dialog-close"));
  if (!providerClose) throw new Error("the provider form has no close control");
  flushSync(() => providerClose.click());
  await waitFor(() => !dialogs().provider, "the provider form did not close");

  const editAgain = buttonByText("Edit");
  if (!editAgain) throw new Error("the Edit entry point disappeared");
  flushSync(() => editAgain.click());
  await waitFor(() => Boolean(dialogs().delegation), "the delegation dialog did not reopen");
  const accountAdvanced = advancedButtons().find((candidate) => {
    const row = candidate.closest(".provider-chosen-row");
    return row && row.textContent.includes("account-model");
  });
  if (!accountAdvanced) throw new Error("the account model row has no Advanced");
  flushSync(() => accountAdvanced.click());
  await waitFor(() => Boolean(dialogs().account || dialogs().provider),
    "clicking Advanced on the account row did not open any editor");
  const accountRoutedToAccount = Boolean(dialogs().account) && !dialogs().provider;
  const delegationClosedForAccount = !dialogs().delegation;

  // No provider-update RPC may be issued by simply opening an editor.
  const providerWrites = calls.filter((call) => call.channel === IPC.invoke.providersUpdate).length;

  return {
    rowCountAtOpen,
    advancedAtOpen,
    apiRoutedToProvider,
    delegationClosedForApi,
    accountRoutedToAccount,
    delegationClosedForAccount,
    providerWrites,
  };
};
`;

test("Advanced on a vendor account opens the account dialog, not the provider form", {
  timeout: 90_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "delegation-routing-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "delegation-routing.jsx"),
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
        "@pi-desktop/shared": join(root, "packages/shared/src"),
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
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.delegationRoutingProbe()");
    console.log("DELEGATION_ROUTING_PROBE " + JSON.stringify(result));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 70_000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("DELEGATION_ROUTING_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("DELEGATION_ROUTING_PROBE ".length));
    assert.deepEqual(result, {
      rowCountAtOpen: 2,
      advancedAtOpen: 2,
      apiRoutedToProvider: true,
      delegationClosedForApi: true,
      accountRoutedToAccount: true,
      delegationClosedForAccount: true,
      providerWrites: 0,
    });
  } finally {
    // Electron keeps its spellcheck dictionary open briefly after the window
    // closes; on Windows the parallel suite can hit EBUSY while removing the
    // profile. Retry, then leave the temp dir rather than failing an assertion
    // that already passed. Do not return from finally: that would swallow a
    // failed assertion from the try block.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(temp, { recursive: true, force: true });
        break;
      } catch (error) {
        if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
});
