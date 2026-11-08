/**
 * Isolated Electron user path for user-definable modes (ADR mode-definitions).
 *
 * The production picker, run status bar and Settings → Modes page run against
 * a fake preload bridge that answers the `modes*` channels the way Electron
 * main does. The probe acts like a user — opens the menu, clicks the run
 * controls, duplicates a builtin and edits its source — and records what
 * reached the bridge, so the assertions read the IPC contract (revision,
 * action, id, source) and the text the user saw.
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
import { IPC } from "@pi-desktop/shared";
import { ComposerModePicker } from "../../apps/desktop/src/features/chat/composer/ComposerModePicker";
import { ModeRunStatusBar } from "../../apps/desktop/src/features/modes/ModeRunStatusBar";
import { ModesSettingsPage } from "../../apps/desktop/src/features/modes/ModesSettingsPage";
import { startModesSync } from "../../apps/desktop/src/features/modes/modes-sync";
import { useModesStore } from "../../apps/desktop/src/features/modes/modes-store";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const GOAL_SOURCE = "---\nname: goal\nlabel: Goal\nbudget: { maxTurns: 20 }\n---\nWork until the objective is verified.\n";
const calls = [];
const listeners = new Map();
const userDocs = new Map();
let run = {
  id: "run-1", sessionId: "session-1", modeId: "review", snapshotHash: "h", input: "go",
  stageId: "design", state: "waiting", waitReason: "approval", revision: 3,
  roundsCompleted: 2, tokensUsed: 0, maxTurns: null, maxTokens: null, artifactPaths: {},
  createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z",
};
let failNextControl = false;

function entry(id, extra) {
  return { id, label: id, description: "", source: "user", staged: false, available: true, ...extra };
}
function catalog() {
  return {
    directory: "/home/user/.pi/modes",
    modes: [
      entry("agent", { source: "builtin", label: "Agent" }),
      entry("plan", { source: "builtin", label: "Plan" }),
      entry("goal", { source: "builtin", label: "Goal", staged: true }),
      entry("review", { label: "Code review", description: "Review the current diff", staged: true }),
      entry("broken", { label: "Broken mode", available: false }),
      entry("plan", { label: "Shadow plan", available: false, reserved: true }),
      ...[...userDocs.keys()].map((id) => entry(id, { label: "Goal", staged: true })),
    ],
    diagnostics: [
      { modeId: "broken", errors: ["stages.work: unknown key \"deploy\""], warnings: [] },
      { modeId: "plan", errors: ["name: \"plan\" is a builtin mode"], warnings: [] },
    ],
  };
}
function emit(channel, payload) {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}
const ok = (data) => ({ ok: true, data });

window.confirm = () => true;
window.piDesktop = {
  platform: "darwin",
  on(channel, listener) {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  async invoke(channel, input) {
    calls.push({ channel, input });
    switch (channel) {
      case IPC.invoke.modesCatalog:
        return ok(catalog());
      case IPC.invoke.modesRead:
        if (input === "goal") return ok({ id: "goal", source: GOAL_SOURCE, builtin: true });
        return ok({ id: input, source: userDocs.get(input), filePath: "/home/user/.pi/modes/" + input + "/mode.md", builtin: false });
      case IPC.invoke.modesValidate:
        return ok(/^bogus:/m.test(input.source)
          ? { ok: false, errors: ["bogus: unknown key"], warnings: [] }
          : { ok: true, errors: [], warnings: [] });
      case IPC.invoke.modesWrite:
        userDocs.set(input.id, input.source);
        return ok(catalog());
      case IPC.invoke.modesDelete:
        userDocs.delete(input);
        return ok(catalog());
      case IPC.invoke.modesRunGet:
        return ok({ run });
      case IPC.invoke.modesRunControl: {
        if (failNextControl) {
          failNextControl = false;
          return { ok: false, error: { code: "MODE_REVISION_CONFLICT", message: "revision conflict" } };
        }
        const state = { pause: "paused", resume: "running", stop: "stopped" }[input.action];
        run = { ...run, state, waitReason: undefined, revision: run.revision + 1 };
        return ok({ run, continue: input.action === "resume" });
      }
      case IPC.invoke.modesRunResolve:
        run = { ...run, state: input.action === "approve" ? "running" : "waiting", waitReason: input.action === "approve" ? undefined : "turn_end", revision: run.revision + 1 };
        return ok({ run, continue: input.action === "approve" });
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
const t = i18n.t.bind(i18n);
const stopSync = startModesSync();

const picks = [];
function Harness() {
  const [view, setView] = React.useState("picker");
  const [open, setOpen] = React.useState(true);
  window.__view = setView;
  if (view === "picker") {
    return React.createElement(ComposerModePicker, {
      t, mode: "agent", planningLive: false, open, setOpen, controlsBlocked: false,
      onCloseOtherMenus: () => {}, onSelect: (mode) => { picks.push(mode); },
    });
  }
  if (view === "run") return React.createElement(ModeRunStatusBar, { sessionId: "session-1" });
  return React.createElement(ModesSettingsPage);
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Harness)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message + " — body: " + document.body.innerText.slice(0, 600));
}
const text = () => document.body.innerText;
function button(label) {
  return [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === label);
}
function typeInto(element, value) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
const sent = (channel) => calls.filter((call) => call.channel === channel).map((call) => call.input);

window.modesProbe = async () => {
  const result = {};

  // 1) The picker: builtins, then the user's modes; unavailable is disabled.
  await waitFor(() => useModesStore.getState().catalog, "catalog never loaded");
  const items = await waitFor(() => {
    const found = [...document.querySelectorAll('[role="menuitemradio"]')];
    return found.length >= 5 ? found : null;
  }, "picker menu did not list user modes");
  result.pickerLabels = items.map((item) => item.textContent.trim());
  const broken = items.find((item) => item.dataset.modeId === "broken");
  result.unavailableDisabled = broken.getAttribute("aria-disabled") === "true";
  result.unavailableReason = broken.getAttribute("title");
  result.customTooltip = items.find((item) => item.dataset.modeId === "review").getAttribute("title");
  flushSync(() => broken.click());
  flushSync(() => items.find((item) => item.dataset.modeId === "review").click());
  await settle();
  result.picks = [...picks];

  // 2) The run status bar: read on open, then every control names its revision.
  flushSync(() => window.__view("run"));
  await waitFor(() => text().includes("Waiting for approval"), "waiting run not shown");
  result.waitingText = text().includes("Rounds 2/∞") && text().includes("design");
  result.waitingButtons = ["Approve", "Reject", "Pause", "Resume", "Stop"].filter((label) => button(label));
  flushSync(() => button("Approve").click());
  await waitFor(() => text().includes("Running"), "approve did not apply");
  result.runningButtons = ["Approve", "Reject", "Pause", "Resume", "Stop"].filter((label) => button(label));
  flushSync(() => button("Pause").click());
  await waitFor(() => text().includes("Paused"), "pause did not apply");
  // A pushed change is shown as is: budget exhausted with the last error.
  run = { ...run, state: "budget_exhausted", revision: 9, lastError: "npm test exited with 1" };
  emit(IPC.event.modesChanged, { sessionId: "session-1", run });
  await waitFor(() => text().includes("Budget exhausted"), "pushed run not shown");
  result.budgetText = text().includes("Last error: npm test exited with 1");
  result.budgetButtons = ["Approve", "Reject", "Pause", "Resume", "Stop"].filter((label) => button(label));
  // A refused control is named in the user's language.
  failNextControl = true;
  flushSync(() => button("Resume").click());
  await waitFor(
    () => useAppStore.getState().toasts.some((toast) => toast.message.includes("changed in the meantime")),
    "conflict was not reported",
  );
  // Stop asks first, then sends the current revision.
  flushSync(() => button("Stop").click());
  await waitFor(() => button("Stop run"), "stop confirmation missing");
  result.stopAsked = text().includes("Stop this run?");
  flushSync(() => button("Stop run").click());
  await waitFor(() => !document.querySelector('[data-testid="mode-run-bar"]'), "stopped run still shown");
  result.resolveRequests = sent(IPC.invoke.modesRunResolve);
  result.controlRequests = sent(IPC.invoke.modesRunControl);

  // 3) Settings → Modes: builtin read-only, duplicate, validate, save, delete.
  flushSync(() => window.__view("settings"));
  await waitFor(() => document.querySelector('[data-testid="modes-directory"]'), "settings list missing");
  result.directory = document.querySelector('[data-testid="modes-directory"]').textContent;
  result.rows = [...document.querySelectorAll(".modes-settings-row")].map((row) => row.dataset.modeId);
  flushSync(() => document.querySelector('.modes-settings-row[data-mode-id="goal"]').click());
  const source = () => document.querySelector(".modes-settings-source");
  await waitFor(() => source()?.value === GOAL_SOURCE, "builtin source not opened");
  result.builtinReadOnly = source().readOnly && !button("Save") && !button("Delete");
  flushSync(() => button("Duplicate").click());
  const idInput = await waitFor(() => document.querySelector(".modes-settings-new input"), "id prompt missing");
  typeInto(idInput, "plan");
  await waitFor(() => text().includes("That id belongs to a built-in mode."), "reserved id not refused");
  typeInto(idInput, "my-goal");
  await settle();
  flushSync(() => document.querySelector('.modes-settings-new button[type="submit"]').click());
  await waitFor(() => source()?.value.startsWith("---\nname: my-goal\n"), "duplicate did not rename");
  result.duplicateSource = source().value;
  typeInto(source(), source().value.replace("---\nWork", "bogus: 1\n---\nWork"));
  await waitFor(() => text().includes("bogus: unknown key"), "validation errors not shown");
  result.saveBlockedByErrors = button("Save").disabled;
  typeInto(source(), result.duplicateSource.replace("label: Goal", "label: My goal"));
  await waitFor(() => text().includes("No problems found"), "valid source not confirmed");
  flushSync(() => button("Save").click());
  await waitFor(() => document.querySelector('.modes-settings-row[data-mode-id="my-goal"]'), "saved mode not listed");
  result.writes = sent(IPC.invoke.modesWrite);
  flushSync(() => button("Delete").click());
  await waitFor(() => button("Click again to delete"), "delete did not arm");
  flushSync(() => button("Click again to delete").click());
  await waitFor(() => !document.querySelector('.modes-settings-row[data-mode-id="my-goal"]'), "deleted mode still listed");
  result.deletes = sent(IPC.invoke.modesDelete);
  result.validations = sent(IPC.invoke.modesValidate).every((input) => input.id === "my-goal");

  stopSync();
  return result;
};
`;

test("modes: picker, run controls and the settings editor follow the IPC contract", {
  timeout: 90_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.modes-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "modes-ui.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
      loader: { ".css": "empty" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        // The contract under test lives in this checkout's shared package.
        "@pi-desktop/shared": join(root, "packages/shared"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      logLevel: "error",
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
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.modesProbe()");
    console.log("MODES_PROBE " + JSON.stringify(result));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 75_000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("MODES_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("MODES_PROBE ".length));

    // Picker: builtins localized first, then user modes as written; the
    // reserved document is not offered and the unavailable one cannot be picked.
    assert.deepEqual(result.pickerLabels.slice(0, 3), ["Agent", "Plan", "Goal"]);
    assert.deepEqual(result.pickerLabels.slice(3, 5), ["Code review", "Broken modeUnavailable"]);
    assert.equal(result.pickerLabels.length, 5);
    assert.equal(result.unavailableDisabled, true);
    assert.equal(result.unavailableReason, 'Unavailable: stages.work: unknown key "deploy"');
    assert.equal(result.customTooltip, "Review the current diff");
    assert.deepEqual(result.picks, ["review"]);

    // Run status bar.
    assert.equal(result.waitingText, true);
    assert.deepEqual(result.waitingButtons, ["Approve", "Reject", "Pause", "Stop"]);
    assert.deepEqual(result.runningButtons, ["Pause", "Stop"]);
    assert.equal(result.budgetText, true);
    assert.deepEqual(result.budgetButtons, ["Resume", "Stop"]);
    assert.equal(result.stopAsked, true);
    assert.deepEqual(result.resolveRequests, [
      { sessionId: "session-1", runId: "run-1", expectedRevision: 3, action: "approve" },
    ]);
    assert.deepEqual(result.controlRequests, [
      { sessionId: "session-1", runId: "run-1", expectedRevision: 4, action: "pause" },
      { sessionId: "session-1", runId: "run-1", expectedRevision: 9, action: "resume" },
      { sessionId: "session-1", runId: "run-1", expectedRevision: 9, action: "stop" },
    ]);

    // Settings → Modes.
    assert.equal(result.directory, "/home/user/.pi/modes");
    assert.deepEqual(result.rows, ["agent", "plan", "goal", "broken", "plan", "review"]);
    assert.equal(result.builtinReadOnly, true);
    assert.equal(
      result.duplicateSource,
      "---\nname: my-goal\nlabel: Goal\nbudget: { maxTurns: 20 }\n---\nWork until the objective is verified.\n",
    );
    assert.equal(result.saveBlockedByErrors, true);
    assert.deepEqual(result.writes, [
      {
        id: "my-goal",
        source: "---\nname: my-goal\nlabel: My goal\nbudget: { maxTurns: 20 }\n---\nWork until the objective is verified.\n",
      },
    ]);
    assert.deepEqual(result.deletes, ["my-goal"]);
    assert.equal(result.validations, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
