/**
 * Isolated Electron user path for the Codemode switch (ADR
 * codemode-sandbox-boundary). The switch lives in Agent behavior → Execution,
 * is off by default, and toggling it writes exactly `codemodeEnabled`.
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
import { AgentBehaviorSettings } from "../../apps/desktop/src/features/settings/pages/AgentBehaviorSettings";

const writes = [];
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  // Neighbouring cards may ask for their own state; none is needed here.
  async invoke() { return { ok: true, data: null }; },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

function Harness() {
  const [settings, setSettings] = React.useState({ defaultMode: "agent", theme: "light", language: "en", developerMode: false });
  const saveSettings = async (patch) => {
    writes.push(patch);
    setSettings((current) => ({ ...current, ...patch }));
  };
  return React.createElement(AgentBehaviorSettings, { settings, saveSettings });
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Harness)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }

window.codemodeSettingsProbe = async () => {
  await settle();
  const toggle = () => document.querySelector('[role="switch"][aria-label="Codemode scripts"]');
  if (!toggle()) throw new Error("the Codemode switch is missing");
  const offByDefault = toggle().getAttribute("aria-checked") === "false";
  // Row descriptions are offered through the help control's accessible label.
  const describesApprovals = [...document.querySelectorAll("[aria-label]")].some(
    (node) => node.getAttribute("aria-label").includes("Each nested call still uses your permission mode and approvals."),
  );
  flushSync(() => toggle().click());
  await settle();
  const onAfterClick = toggle().getAttribute("aria-checked") === "true";
  flushSync(() => toggle().click());
  await settle();
  const offAfterSecondClick = toggle().getAttribute("aria-checked") === "false";
  return { offByDefault, describesApprovals, onAfterClick, offAfterSecondClick, writes };
};
`;

test("the Codemode switch is off by default and persists codemodeEnabled", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.codemode-settings-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "codemode-settings.jsx"),
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
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.codemodeSettingsProbe()");
    console.log("CODEMODE_SETTINGS_PROBE " + JSON.stringify(result));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("CODEMODE_SETTINGS_PROBE "));
    assert(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("CODEMODE_SETTINGS_PROBE ".length)), {
      offByDefault: true,
      describesApprovals: true,
      onAfterClick: true,
      offAfterSecondClick: true,
      writes: [{ codemodeEnabled: true }, { codemodeEnabled: false }],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
