/**
 * Isolated Electron user path for adding Jev as a service (D625).
 *
 * Jev is offered where a service is added, not where an existing row is
 * edited, and adding it is one action with two steps: check the TypeSafe key,
 * then store it and turn the classifier on. The check comes first and nothing
 * is written when it fails — otherwise a saved key would be a key the Agent
 * cannot spend, and "enabled" would mean nothing.
 */
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
import { JEV_API_KEY_SECRET_REF } from "@pi-desktop/shared";
import { JevSettingsCard } from "../../apps/desktop/src/components/settings/JevSettingsCard";
import { ProviderSetupDialog } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { ServiceChooser } from "../../apps/desktop/src/components/settings/ServiceChooser";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const apiCalls = [];
let savedKey;
let jevCheck = { ok: true, status: 200 };
/** Set to hold the next check open, so a test can close the dialog mid-flight. */
let pendingCheck = null;
let pickedService = null;
let configured = false;
let savedSettings = {
  defaultMode: "agent",
  theme: "light",
  language: "en",
  developerMode: false,
  jevEnabled: false,
};
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    apiCalls.push({ channel, input });
    switch (channel) {
      case "pi-desktop/jev/test":
        if (pendingCheck) {
          return new Promise((resolve) => {
            pendingCheck.resolve = () => resolve({ ok: true, data: pendingCheck.result });
          });
        }
        return { ok: true, data: jevCheck };
      case "pi-desktop/secrets/has":
        if (input !== JEV_API_KEY_SECRET_REF) throw new Error("unexpected secret ref");
        return { ok: true, data: { has: typeof savedKey === "string" } };
      case "pi-desktop/secrets/set":
        if (input.secretRef !== JEV_API_KEY_SECRET_REF) throw new Error("unexpected secret ref");
        savedKey = input.value;
        return { ok: true, data: undefined };
      case "pi-desktop/settings/set":
        savedSettings = input;
        useAppStore.setState({ settings: savedSettings });
        return { ok: true, data: undefined };
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
useAppStore.setState({ settings: savedSettings });

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
function button(label) {
  return [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim() === label);
}
function setValue(input, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  valueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function jevTile() {
  return [...document.querySelectorAll('[data-service-id="jev"]')][0];
}

const rootNode = createRoot(document.getElementById("root"));
function mount(element) {
  flushSync(() => rootNode.render(element));
}
function jevDialog(key) {
  return React.createElement(ProviderSetupDialog, {
    key,
    provider: null,
    initialService: "jev",
    onClose: () => { mount(null); },
    onSaved: () => {},
    onJevConfigured: () => { configured = true; },
  });
}

/**
 * The settings page's own wiring: the dialog is opened where the service
 * chooser opens it, and the dialog's report of a stored key is what makes the
 * card read the state and appear on the page.
 */
function JevSurface({ initiallyOpen = false }) {
  const settings = useAppStore((state) => state.settings);
  const [open, setOpen] = React.useState(initiallyOpen);
  const [revision, setRevision] = React.useState(0);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(JevSettingsCard, {
      settings: settings ?? undefined,
      onConfigure: () => setOpen(true),
      statusRevision: revision,
    }),
    open
      ? React.createElement(ProviderSetupDialog, {
          provider: null,
          initialService: "jev",
          onClose: () => setOpen(false),
          onSaved: () => {},
          onJevConfigured: () => {
            setOpen(false);
            setRevision((value) => value + 1);
            configured = true;
          },
        })
      : null,
  );
}

window.jevServiceSetupProbe = async () => {
  // 1) The add path offers Jev beside the API services.
  mount(React.createElement(ServiceChooser, {
    showClassifiers: true,
    onPickService: (id) => { pickedService = id; },
  }));
  await settle();
  const offersClassifiers = document.body.innerText.includes("Classifiers");
  const tile = jevTile();
  if (!tile) throw new Error("the add path must offer Jev");
  flushSync(() => tile.click());
  await settle();
  const pickedJev = pickedService === "jev";

  // 2) Editing an existing row cannot turn it into a classifier.
  mount(React.createElement(ServiceChooser, {
    showClassifiers: false,
    onPickService: () => {},
  }));
  await settle();
  const hiddenWhenEditing = !jevTile();
  const hiddenGroup = !document.body.innerText.includes("Classifiers");

  // 3) Jev is not added yet, so the page shows no card: this dialog is opened
  // the way the service chooser opens it. Adding the service checks the key,
  // stores it, turns Jev on, and the card appears because the key is there.
  apiCalls.length = 0;
  savedKey = undefined;
  configured = false;
  jevCheck = { ok: true, status: 200 };
  mount(React.createElement(JevSurface, { initiallyOpen: true }));
  const cardAbsentBefore = !document.querySelector('[role="switch"][aria-label="Enable Jev for Agent"]');
  await waitFor(() => !!document.querySelector('input[aria-label="TypeSafe API key"]'), "the Jev form did not open");
  // The dialog is portaled onto documentElement, so the whole page is read.
  const privacyNoticeShown = await waitFor(
    () => document.documentElement.innerText.includes("sent directly to TypeSafe"),
    "the Jev form must carry the privacy notice",
  );
  const noModelPanes = !document.documentElement.innerText.includes("Models from this service");
  setValue(document.querySelector('input[aria-label="TypeSafe API key"]'), "jev-ui-fixture-key");
  await settle();
  flushSync(() => button("Check and save").click());
  await waitFor(
    () => document.body.innerText.includes("API key saved securely"),
    "the card did not pick up the key the dialog stored",
  );
  const cardSwitch = document.querySelector('[role="switch"][aria-label="Enable Jev for Agent"]');
  const switchOn = cardSwitch?.getAttribute("aria-checked") === "true";
  const dialogClosed = !document.querySelector('input[aria-label="TypeSafe API key"]');
  // The check, the store and the switch, in that order.
  const flow = apiCalls.filter((call) => call.channel !== "pi-desktop/secrets/has");
  const checkedFirst = flow[0]?.channel === "pi-desktop/jev/test";
  const checkedTheTypedKey = checkedFirst && flow[0].input === "jev-ui-fixture-key";
  const storedAfterChecking = flow[1]?.channel === "pi-desktop/secrets/set"
    && flow[1].input.secretRef === JEV_API_KEY_SECRET_REF
    && flow[1].input.value === "jev-ui-fixture-key";
  const enabledAfterStoring = flow[2]?.channel === "pi-desktop/settings/set"
    && flow[2].input.jevEnabled === true;

  // 4) A key TypeSafe refuses is never stored and never enabled.
  apiCalls.length = 0;
  savedKey = undefined;
  configured = false;
  useAppStore.setState({ toasts: [] });
  jevCheck = { ok: false, status: 401, message: "TypeSafe returned 401: invalid api key" };
  mount(jevDialog("refused"));
  await waitFor(() => !!document.querySelector('input[aria-label="TypeSafe API key"]'), "the Jev form did not reopen");
  setValue(document.querySelector('input[aria-label="TypeSafe API key"]'), "jev-rejected-key");
  await settle();
  flushSync(() => button("Check and save").click());
  await waitFor(() => apiCalls.some((call) => call.channel === "pi-desktop/jev/test"), "the key was never checked");
  await settle();
  await settle();
  const refused = {
    nothingStored: savedKey === undefined
      && !apiCalls.some((call) => call.channel === "pi-desktop/secrets/set"),
    nothingEnabled: !apiCalls.some((call) => call.channel === "pi-desktop/settings/set"),
    stillOpen: !!document.querySelector('input[aria-label="TypeSafe API key"]'),
    notConfigured: configured === false,
    reported: useAppStore.getState().toasts.some(
      (item) => item.variant === "error" && item.message.includes("401"),
    ),
  };

  // 5) Closing the dialog while the check is in flight cancels the action: an
  // abandoned dialog must not leave a stored credential behind.
  apiCalls.length = 0;
  savedKey = undefined;
  configured = false;
  useAppStore.setState({ toasts: [] });
  pendingCheck = { resolve: null, result: { ok: true, status: 200 } };
  mount(jevDialog("abandoned"));
  await waitFor(() => !!document.querySelector('input[aria-label="TypeSafe API key"]'), "the Jev form did not open");
  setValue(document.querySelector('input[aria-label="TypeSafe API key"]'), "jev-abandoned-key");
  await settle();
  flushSync(() => button("Check and save").click());
  await waitFor(() => apiCalls.some((call) => call.channel === "pi-desktop/jev/test"), "the check never started");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await waitFor(() => !document.querySelector('input[aria-label="TypeSafe API key"]'), "Escape did not close the Jev form");
  flushSync(() => pendingCheck.resolve());
  await settle();
  await settle();
  const abandoned = {
    nothingStored: savedKey === undefined
      && !apiCalls.some((call) => call.channel === "pi-desktop/secrets/set"),
    nothingEnabled: !apiCalls.some((call) => call.channel === "pi-desktop/settings/set"),
    noSuccessToast: !useAppStore.getState().toasts.some((item) => item.variant === "success"),
  };
  pendingCheck = null;

  return {
    offersClassifiers,
    pickedJev,
    hiddenWhenEditing,
    hiddenGroup,
    privacyNoticeShown,
    noModelPanes,
    cardAbsentBefore,
    switchOn,
    dialogClosed,
    checkedFirst,
    checkedTheTypedKey,
    storedAfterChecking,
    enabledAfterStoring,
    refusedNothingStored: refused.nothingStored,
    refusedNothingEnabled: refused.nothingEnabled,
    refusedStaysOpen: refused.stillOpen,
    refusedNotConfigured: refused.notConfigured,
    refusedReported: refused.reported,
    abandonedNothingStored: abandoned.nothingStored,
    abandonedNothingEnabled: abandoned.nothingEnabled,
    abandonedSilent: abandoned.noSuccessToast,
  };
};
`;

test("adding Jev checks the key, enables it, shows the card, and cancels on close", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.jev-service-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "jev-service-setup.jsx"),
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
    const result = await win.webContents.executeJavaScript("window.jevServiceSetupProbe()");
    console.log("JEV_SERVICE_PROBE " + JSON.stringify(result));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("JEV_SERVICE_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("JEV_SERVICE_PROBE ".length));
    assert.deepEqual(result, {
      offersClassifiers: true,
      pickedJev: true,
      hiddenWhenEditing: true,
      hiddenGroup: true,
      privacyNoticeShown: true,
      noModelPanes: true,
      switchOn: true,
      cardAbsentBefore: true,
      dialogClosed: true,
      checkedFirst: true,
      checkedTheTypedKey: true,
      storedAfterChecking: true,
      enabledAfterStoring: true,
      refusedNothingStored: true,
      refusedNothingEnabled: true,
      refusedStaysOpen: true,
      refusedNotConfigured: true,
      refusedReported: true,
      abandonedNothingStored: true,
      abandonedNothingEnabled: true,
      abandonedSilent: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
