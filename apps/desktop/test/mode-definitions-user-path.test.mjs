import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const PROMPT = "Coordinate the review.\n";
const ORACLE = [
  "---",
  "name: oracle",
  "description: Technical judgment, read-only.",
  "tools: inherit",
  "provider: anthropic",
  "model: claude-opus-4",
  "thinkingLevel: high",
  "fallbackModels:",
  "  - anthropic/claude-sonnet-4",
  "  - openai/gpt-5-mini",
  "fallbackThinkingLevels:",
  "  - low",
  "  - inherit",
  "---",
  "",
  "Review only. Do not edit files.",
  "",
].join("\n");
const FIXER = "---\nname: fixer\ndescription: Implements the fix.\ntools: [Read, Edit]\n---\n\nFix it.\n";
const LEGACY_SOURCE = "---\nname: legacy-review\nlabel: Legacy review\npermission: agent\n---\nReview the diff.\n";
const SKILL_DIR = "skills/verify-delivery";
const SKILL_DOC = "---\nname: Verify delivery\ndescription: Check the result.\n---\n\nSee guides/checklist.md.\n";
const SKILL_RESOURCE = "Checklist kept beside the skill.\n";
const SKILL_BYTES = Buffer.from([0, 1, 254, 255]);
const NOTE = "A note not managed by the mode.\n";
const BUNDLE = [
  "name: sisyphus",
  "label: Sisyphus",
  "permission: agent",
  "promptFile: prompts/orchestrator.md",
  "subagents:",
  "  - agents/oracle.agent.md",
  "  - agents/fixer.agent.md",
  "disabledSkills: [not-installed] # Keep it disabled if installed later.",
  "artifacts:",
  "  report:",
  "    path: report.md",
  "    template: templates/report.md",
  "stages:",
  "  review: {}",
  "",
].join("\n");

const rendererSource = String.raw`
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
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { ToastHost } from "../../apps/desktop/src/components/Toast";

await i18n.use(initReactI18next).init({
  lng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);
const now = "2026-11-07T00:00:00Z";
const provider = (vendorKey, name, protocol, ids) => ({
  id: "fixture-" + vendorKey, name, vendorKey, protocol, type: "native", enabled: true,
  authKind: "apikey", hasSecret: true, models: ids.map((id) => ({ id })), createdAt: now, updatedAt: now,
});
useAppStore.setState({ providers: [
  provider("anthropic", "Anthropic", "anthropic", ["claude-opus-4", "claude-sonnet-4"]),
  provider("openai", "OpenAI", "openai-responses", ["gpt-5", "gpt-5-mini"]),
] });
window.confirm = () => true;
const stopSync = startModesSync();
const picks = [];
let show;
function Harness() {
  const [view, setView] = React.useState("picker");
  const [open, setOpen] = React.useState(true);
  show = (next) => flushSync(() => setView(next));
  const content = view === "picker" ? React.createElement(ComposerModePicker, {
    t, mode: "agent", planningLive: false, open, setOpen, controlsBlocked: false,
    onCloseOtherMenus: () => {}, onSelect: (mode) => picks.push(mode),
  }) : view === "run" ? React.createElement(ModeRunStatusBar, { sessionId: "session-1" })
    : React.createElement(ModesSettingsPage);
  return React.createElement(React.Fragment, null, content, React.createElement(ToastHost));
}
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(React.createElement(Harness)));

const fixture = window.modeFixture.command;
// A hidden Electron window on Windows may never deliver animation frames.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, description) {
  const deadline = performance.now() + 4000;
  do {
    const value = await predicate();
    if (value) return value;
    await tick();
  } while (performance.now() < deadline);
  throw new Error(description + ": " + document.body.innerText.slice(-1500));
}
const query = (selector, scope = document) => scope.querySelector(selector);
const all = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const button = (label, scope) => all("button", scope).find((node) =>
  (node.getAttribute("aria-label") ?? node.textContent.trim()) === label);
const field = (label) => query('textarea[aria-label="' + label + '"]');
const modeSource = () => field(t("modes.settings.modeMap"));
const legacySource = () => field(t("modes.settings.source"));
const prompt = () => field(t("modes.settings.promptTitle"));
const currentId = () => query('[data-testid="modes-tabs"]')?.dataset.modeId;
const modeRow = (id) => query('button[data-mode-id="' + id + '"]:not([aria-disabled="true"])');
const tabs = () => all('[data-testid="modes-tabs"] [role="tab"]');
const tabLabels = () => tabs().map((node) => node.textContent.trim());
const roleRow = (reference) => query('[data-role-reference="' + reference + '"]');
const checked = (node) => node?.getAttribute("aria-checked");
const skillSwitch = () => button(t("settings.enableCapability", { name: "Verify delivery" }));
const skillsDirectory = () => query('[data-testid="modes-skills-directory"]')?.textContent;
const save = () => button(t("modes.settings.save"));
const openFolder = () => button(t("modes.settings.openSkillsDirectory"));
const click = (node) => flushSync(() => node.click());
const showCatalog = () => {
  if (!query('[data-testid="modes-directory"]')) click(button(t("modes.settings.listTitle")));
};
const selectMode = async (id) => {
  showCatalog();
  click(await waitFor(() => modeRow(id), "Mode row missing: " + id));
  await waitFor(() => currentId() === id && tabs().every((node) => !node.disabled), "Mode did not open: " + id);
};
function selectTab(label) {
  const tab = tabs().find((node) => node.textContent.trim() === label);
  click(tab);
  const panel = document.getElementById(tab.getAttribute("aria-controls"));
  if (tab.getAttribute("aria-selected") !== "true" || !panel || panel.hidden || panel.getAttribute("aria-labelledby") !== tab.id) {
    throw new Error("Selected tab is not attached to its visible panel: " + label);
  }
}
const typeInto = (element, value) => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
async function enterId(action, id) {
  click(button(action));
  const form = await waitFor(() => query(".modes-settings-new"), "Mode id form did not open");
  typeInto(query("input", form), id);
  return query('button[type="submit"]', form);
}
async function choose(trigger, option) {
  click(trigger);
  click(await waitFor(() => all('[role="option"]').find((node) => node.textContent.trim() === option), "Missing option: " + option));
}
async function releaseReply() {
  await fixture("release");
  // Flush the delivered IPC reply and its React update before reading the DOM.
  await tick();
  await tick();
}
const sent = async (channel) => (await fixture("calls")).filter((call) => call.channel === channel).map((call) => call.input);

window.modesProbe = async () => {
  try {
    const result = {};
    const items = await waitFor(() => {
      const found = all('[role="menuitemradio"]');
      return found.some((item) => item.dataset.modeId === "sisyphus") && found;
    }, "Picker never loaded user modes");
    result.pickerLabels = items.slice(0, 3).map((item) => item.textContent.trim());
    const broken = items.find((item) => item.dataset.modeId === "broken");
    result.unavailableReason = broken.title;
    result.unavailable = broken.getAttribute("aria-disabled");
    click(broken);
    click(items.find((item) => item.dataset.modeId === "sisyphus"));
    result.picks = [...picks];

    show("run");
    await waitFor(() => button("Approve"), "Waiting run not shown");
    result.waitingRun = query('[data-testid="mode-run-bar"]').innerText;
    click(button("Approve"));
    click(await waitFor(() => !button("Approve") && !button("Pause")?.disabled && button("Pause"), "Approve did not apply"));
    await waitFor(() => button("Resume") && !button("Resume").disabled, "Pause did not apply");
    await fixture("budget-exhausted");
    await waitFor(() => document.body.innerText.includes("Budget exhausted"), "Pushed budget was not shown");
    click(button("Edit"));
    const form = query('[data-testid="mode-run-edit"]');
    const [objective, turns, tokens] = all("textarea, input", form);
    typeInto(turns, "0");
    result.invalidBudgetBlocked = save().disabled;
    typeInto(objective, "Review the docs too");
    typeInto(turns, "40");
    typeInto(tokens, "200000");
    click(save());
    await waitFor(() => !query('[data-testid="mode-run-edit"]') && document.body.innerText.includes("Rounds 2/40"), "Run edit did not apply");
    await fixture("conflict");
    click(button("Resume"));
    await waitFor(() => document.body.innerText.includes("changed in the meantime") && !button("Stop").disabled, "Revision conflict not shown");
    click(button("Stop"));
    click(await waitFor(() => button("Stop run"), "Stop confirmation not shown"));
    await waitFor(() => !query('[data-testid="mode-run-bar"]'), "Stopped run still visible");
    await fixture("next-run");
    click(await waitFor(() => button("Remove"), "New run was not shown"));
    click(await waitFor(() => button("Remove run"), "Remove confirmation not shown"));
    await waitFor(() => !query('[data-testid="mode-run-bar"]'), "Removed run still visible");
    result.runResolve = await sent(IPC.invoke.modesRunResolve);
    result.runControl = await sent(IPC.invoke.modesRunControl);
    result.runUpdate = await sent(IPC.invoke.modesRunUpdate);

    show("settings");
    result.directory = (await waitFor(() => query('[data-testid="modes-directory"]'), "Settings list missing")).textContent;
    await selectMode("sisyphus");
    result.tabs = tabLabels();
    result.detailReplacesCatalog = !modeRow("sisyphus") && !query('[data-testid="modes-directory"]');
    result.modeOnly = !prompt();
    result.source = modeSource().value;
    selectTab("Prompt");
    result.prompt = prompt().value;
    result.promptOnly = !modeSource();
    selectTab("Mode");
    result.globalDefault = checked(button(t("modes.settings.includeGlobalSubagents")));
    click(button(t("modes.settings.includeGlobalSubagents")));
    click(save());
    await waitFor(() => save()?.disabled, "Include global subagents did not save");
    await selectMode("legacy-review");
    result.legacyTabs = tabLabels();
    result.legacySource = legacySource().value;

    click(await enterId("Duplicate", "legacy-copy"));
    await waitFor(() => currentId() === "legacy-copy" && legacySource(), "Legacy duplicate did not open");
    const legacyCopy = legacySource().value;
    typeInto(legacySource(), legacyCopy.replace("permission: agent", "permission: invalid"));
    await waitFor(() => query('[data-testid="modes-validation"]').innerText.includes("Errors"), "Legacy validation errors not shown");
    result.legacyErrorsBlockSave = save().disabled;
    typeInto(legacySource(), legacyCopy);
    click(save());
    await waitFor(() => save()?.disabled, "Legacy duplicate did not save");
    showCatalog();
    click(await enterId("New mode", "my-mode"));
    await waitFor(() => currentId() === "my-mode", "New mode not opened");
    result.newTabs = tabLabels();
    selectTab("Prompt");
    result.newHasPrompt = prompt().value.length > 0;
    result.newCanSave = !save().disabled;
    result.newDuplicateDisabled = button("Duplicate").disabled;
    const starterPrompt = prompt().value;
    typeInto(prompt(), "");
    result.newBlankPromptBlocked = save().disabled;
    typeInto(prompt(), starterPrompt);
    click(save());
    await waitFor(() => save()?.disabled, "New bundle was not created");
    await selectMode("my-mode");
    result.newReopened = modeSource().value;

    await selectMode("sisyphus");
    click(await enterId("Duplicate", "sisyphus-copy"));
    await waitFor(() => currentId() === "sisyphus-copy" && save()?.disabled, "Host copy did not open");
    result.copyMap = modeSource().value;
    result.copyGlobal = checked(button(t("modes.settings.includeGlobalSubagents")));
    selectTab("Prompt");
    result.copyPrompt = prompt().value;
    selectTab("Skills");
    result.copiedSkillEnabled = checked(await waitFor(() => skillSwitch(), "Copy did not discover its own skill"));
    selectTab("Subagents");
    result.copyRoles = all("[data-role-reference]").map((node) => node.dataset.roleReference);
    result.copyCalls = await sent(IPC.invoke.modesCopy);
    result.copyWasNotWritten = !(await sent(IPC.invoke.modesBundleWrite)).some(({ id }) => id === "sisyphus-copy")
      && !(await sent(IPC.invoke.modesWrite)).some(({ id }) => id === "sisyphus-copy");
    result.copyTakenDisabled = (await enterId("Duplicate", "sisyphus")).disabled;
    click(button("Cancel"));

    click(roleRow("agents/oracle.agent.md"));
    result.roleReplacesList = !roleRow("agents/oracle.agent.md") && !!query('[data-testid="mode-role-detail"]');
    const roleDetail = () => query('[data-testid="mode-role-detail"]');
    const showRoleModel = () => click(all('[role="tab"]', roleDetail()).find((tab) => tab.textContent.trim() === t("extensions.subagents.model")));
    showRoleModel();
    const model = () => button(t("extensions.subagents.model"), query('[role="tabpanel"]', roleDetail()));
    result.roleInitialModel = model().textContent.trim();
    await choose(model(), "gpt-5");
    const reasoning = () => button(t("extensions.subagents.thinking"), query(".modes-settings-fallback"));
    await choose(reasoning(), "medium");
    click(save());
    click(button(t("modes.settings.rolesTitle"), roleDetail()));
    if (!roleRow("agents/oracle.agent.md") || roleDetail()) throw new Error("Returning from a role did not restore its list");
    await waitFor(() => save()?.disabled, "Role change did not save");
    await selectMode("sisyphus");
    await selectMode("sisyphus-copy");
    selectTab("Subagents");
    result.roleSelectionCleared = !query('[data-role-reference][aria-current="true"]');
    click(roleRow("agents/oracle.agent.md"));
    showRoleModel();
    result.roleModelReopened = model().textContent.trim();
    result.fallbackThinkingReopened = reasoning().textContent.trim();

    // Unlike an occupied mode id, an unmanaged directory is not in the list.
    click(await enterId("Duplicate", "occupied"));
    await waitFor(() => document.body.innerText.includes('the destination "occupied" already exists'), "Host copy conflict was not shown");
    await waitFor(() => !button("Cancel").disabled, "Conflict did not re-enable form");
    click(button("Cancel"));
    result.copyConflict = currentId();

    await fixture("hold", IPC.invoke.modesCopy, "late-copy");
    click(await enterId("Duplicate", "late-copy"));
    await waitFor(() => fixture("held"), "Duplicate reply not held");
    await selectMode("my-mode");
    await releaseReply();
    await waitFor(() => save()?.disabled, "Late copy did not settle");
    result.modeAfterStaleCopy = [currentId(), modeSource().value];

    // Refuse writing over an unmanaged path from a saved mode.
    await selectMode("sisyphus");
    typeInto(modeSource(), modeSource().value.replace("prompts/orchestrator.md", "notes.md"));
    const writes = (await sent(IPC.invoke.modesBundleWrite)).length;
    click(save());
    await waitFor(() => document.body.innerText.includes(t("modes.settings.referencesFixed")), "Reference change was not refused");
    result.noUnmanagedWrite = (await sent(IPC.invoke.modesBundleWrite)).length === writes;
    await selectMode("legacy-review");
    await selectMode("sisyphus");

    selectTab("Skills");
    await waitFor(() => skillSwitch(), "Private skill not listed");
    result.skillsDirectory = skillsDirectory();
    result.skillLabel = !!skillSwitch();
    result.skillInitiallyOn = checked(skillSwitch());
    click(openFolder());
    await waitFor(async () => (await fixture("opened")).length && !openFolder()?.disabled, "Open folder not handed to shell");
    result.skillsOpened = await fixture("opened");

    // A mode-local switch must not discard an unrelated prompt draft.
    selectTab("Prompt");
    const originalPrompt = prompt().value;
    typeInto(prompt(), "Unsaved prompt edit");
    selectTab("Skills");
    click(skillSwitch());
    await waitFor(() => checked(skillSwitch()) === "false" && !skillSwitch().disabled, "Skill did not turn off");
    selectTab("Prompt");
    result.promptAfterToggle = prompt().value;
    typeInto(prompt(), originalPrompt);

    // Complete a settings write after the user opened a different mode.
    selectTab("Skills");
    await fixture("hold", IPC.invoke.modesBundleSettings, "sisyphus");
    click(skillSwitch());
    await waitFor(() => fixture("held"), "Skill settings reply not held");
    await selectMode("my-mode");
    await releaseReply();
    await waitFor(() => save()?.disabled, "Settings write did not settle");
    result.modeAfterStaleWrite = [currentId(), modeSource().value];
    result.skillPatches = await sent(IPC.invoke.modesBundleSettings);

    // Complete a bundle read and a skills read out of order.
    showCatalog();
    await fixture("hold", IPC.invoke.modesBundleRead, "sisyphus");
    click(modeRow("sisyphus"));
    await waitFor(() => fixture("held"), "Bundle reply not held");
    await selectMode("sisyphus-copy");
    await releaseReply();
    result.modeAfterStaleRead = [currentId(), modeSource().value];

    await fixture("hold", IPC.invoke.modesSkills, "sisyphus");
    await selectMode("sisyphus");
    selectTab("Skills");
    await waitFor(() => fixture("held"), "Skills reply not held");
    await selectMode("my-mode");
    selectTab("Skills");
    await waitFor(() => skillsDirectory(), "Current mode's skills directory not shown");
    await releaseReply();
    result.afterStaleSkills = [currentId(), skillsDirectory(), Boolean(skillSwitch())];
    await selectMode("sisyphus");
    selectTab("Skills");
    await waitFor(() => skillSwitch(), "Original skill did not reload");
    result.skillReenabled = checked(skillSwitch());

    await selectMode("goal");
    const shipped = legacySource().value;
    typeInto(legacySource(), shipped + "\nCheck the completed work.\n");
    click(save());
    click(await waitFor(() => button("Restore default"), "Builtin override was not saved"));
    click(await waitFor(() => button("Click again to restore"), "Restore did not arm"));
    await waitFor(() => legacySource()?.value === shipped && !button("Restore default"), "Builtin was not restored");
    result.restore = await sent(IPC.invoke.modesDelete);
    return result;
  } finally {
    stopSync();
    root.unmount();
  }
};
`;

// The real preload and mode handlers run in Electron. Run state and the OS
// file manager are the only simulated service edges; bundle operations hit disk.
const mainSource = `
import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = ${JSON.stringify(root)};
const dir = import.meta.dirname;
app.setPath("userData", join(dir, "profile"));
app.commandLine.appendSwitch("disable-background-networking");

async function main() {
  register(pathToFileURL(join(root, "apps/desktop/test/helpers/ts-import-hooks.mjs")));
  const { registerModesIpc } = await import(pathToFileURL(join(root, "apps/desktop/electron/main/ipc/modes-ipc.ts")));
  const { createModeCatalogService } = await import(pathToFileURL(join(root, "apps/desktop/electron/main/runtime/mode-catalog.ts")));
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(dir, "preload.cjs"), backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, reply) => reply({ cancel: true }));
  const calls = [];
  const opened = [];
  const catalog = createModeCatalogService({ dir: join(dir, "modes") });
  let hold;
  let rejectNextControl = false;
  const { IPC } = await import(pathToFileURL(join(root, "packages/shared/src/protocol.ts")));
  ipcMain.handle("modes-ui:fixture", async (_event, command, ...args) => {
    if (command === "calls") return calls;
    if (command === "opened") return opened;
    if (command === "budget-exhausted" || command === "next-run") {
      run = command === "budget-exhausted" ? { ...run, state: "budget_exhausted", revision: 9 }
        : { ...run, id: "run-2", state: "running", revision: 20 };
      win.webContents.send(IPC.event.modesChanged, { sessionId: run.sessionId, run });
      return;
    }
    if (command === "conflict") { rejectNextControl = true; return; }
    if (command === "held") return Boolean(hold?.release);
    if (command === "hold") {
      if (hold) throw new Error("Fixture reply is already held");
      hold = { channel: args[0], id: args[1] };
      return;
    }
    if (command === "release") {
      if (!hold?.release) throw new Error("No fixture reply to release");
      hold.release();
      hold = undefined;
      // Allow the held handler to reply before the fixture acknowledges release.
      await new Promise(setImmediate);
      return;
    }
    throw new Error("Unexpected fixture command: " + command);
  });
  let run = {
    id: "run-1", sessionId: "session-1", modeId: "sisyphus", snapshotHash: "h", input: "go",
    stageId: "design", state: "waiting", waitReason: "approval", revision: 3,
    roundsCompleted: 2, tokensUsed: 0, maxTurns: null, maxTokens: null, artifactPaths: {},
    createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z",
  };
  function moveRun(state) {
    run = { ...run, state, waitReason: undefined, revision: run.revision + 1 };
    return { run, continue: state === "running" };
  }
  registerModesIpc({
    catalog,
    registrar: { handle(channel, handler) {
      ipcMain.handle(channel, async (_event, input) => {
        calls.push({ channel, input });
        try {
          const data = await handler(input);
          const id = typeof input === "string" ? input : input?.id ?? input?.toId;
          if (hold?.channel === channel && hold.id === id && !hold.release) {
            await new Promise((release) => { hold.release = release; });
          }
          return { ok: true, data };
        } catch (error) {
          return { ok: false, error: { message: error.message, code: error.errorCode, details: error.data } };
        }
      });
    } },
    runs: {
      get: async () => ({ run }),
      control: async ({ action }) => {
        if (rejectNextControl) {
          rejectNextControl = false;
          throw Object.assign(new Error("revision conflict"), { errorCode: "MODE_REVISION_CONFLICT" });
        }
        return moveRun({ pause: "paused", resume: "running", stop: "stopped", remove: "stopped" }[action]);
      },
      resolve: async () => moveRun("running"),
      update: async ({ input, budget }) => {
        run = { ...run, input, ...budget, revision: run.revision + 1 };
        return { run, continue: false };
      },
    },
    openPath: async (folder) => { opened.push(folder); return ""; },
  });
  const consoleMessages = [];
  win.webContents.on("console-message", (event) => consoleMessages.push(event.message));
  try {
    await win.loadFile(join(dir, "index.html"));
    return await win.webContents.executeJavaScript("window.modesProbe()");
  } catch (err) {
    throw new Error(err.stack + "\\n" + consoleMessages.join("\\n"));
  }
}
function finish(report) {
  writeFileSync(join(dir, "result.json"), JSON.stringify(report));
  app.exit(report.error ? 1 : 0);
}
app.whenReady().then(main).then(
  (result) => finish({ result }),
  (error) => finish({ error: String(error.stack ?? error) }),
);
`;

async function writeFixture(files, directory) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function runElectron(temp) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.mjs")], {
    env, cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output += chunk; });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 90_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const report = JSON.parse(await readFile(join(temp, "result.json"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "null";
    }));
    assert.equal(code, 0, report?.error ?? `${timedOut ? "Electron probe timed out" : "No Electron probe report"}\n${output}`);
    assert.ok(report?.result, "Missing Electron probe result");
    return report.result;
  } finally {
    clearTimeout(timer);
  }
}

test("modes: grouped Electron settings create, copy and edit private mode documents", {
  timeout: 120_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires an Electron display" : false,
}, async (t) => {
  const temp = await mkdtemp(join(await realpath(process.env.PI_SCRATCH_DIR || tmpdir()), "modes-ui-"));
  try {
    const modes = join(temp, "modes");
    const original = join(modes, "sisyphus");
    const copy = join(modes, "sisyphus-copy");
    await writeFixture({
      "sisyphus/mode.yaml": BUNDLE,
      "sisyphus/prompts/orchestrator.md": PROMPT,
      "sisyphus/agents/oracle.agent.md": ORACLE,
      "sisyphus/agents/fixer.agent.md": FIXER,
      "sisyphus/notes.md": NOTE,
      "sisyphus/templates/report.md": "Private report template.\n",
      ["sisyphus/" + SKILL_DIR + "/SKILL.md"]: SKILL_DOC,
      ["sisyphus/" + SKILL_DIR + "/guides/checklist.md"]: SKILL_RESOURCE,
      ["sisyphus/" + SKILL_DIR + "/assets/raw.bin"]: SKILL_BYTES,
      "occupied/notes.md": NOTE,
      "legacy-review/mode.md": LEGACY_SOURCE,
      "broken/mode.yaml": "name: broken\ninvalid: true\n",
    }, modes);
    await Promise.all([
      build({
        stdin: { contents: rendererSource, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
        outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
        loader: { ".css": "empty" },
        alias: {
          "@pi-desktop/i18n": join(root, "packages/i18n/src"),
          "@pi-desktop/shared": join(root, "packages/shared/src"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
          i18next: join(root, "apps/desktop/node_modules/i18next"),
          "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
      }),
      build({
        stdin: {
          contents: `import "./index.ts";
            import { contextBridge, ipcRenderer } from "electron";
            contextBridge.exposeInMainWorld("modeFixture", {
              command: (...args) => ipcRenderer.invoke("modes-ui:fixture", ...args),
            });`,
          resolveDir: join(root, "apps/desktop/electron/preload"),
        },
        outfile: join(temp, "preload.cjs"), bundle: true, platform: "node", external: ["electron"],
        alias: { "@pi-desktop/shared": join(root, "packages/shared/src") },
      }),
      writeFixture({
        "index.html": `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><body><div id="root"></div><script type="module" src="renderer.js"></script>`,
        "main.mjs": mainSource,
      }, temp),
    ]);

    const result = await runElectron(temp);
    await t.test("grouped tabs, user mode picker, run controls and legacy restore", () => {
      assert.deepEqual(result.pickerLabels, ["Agent", "Plan", "Goal"]);
      assert.equal(result.unavailable, "true");
      assert.match(result.unavailableReason, /^Unavailable: .*invalid:/);
      assert.deepEqual(result.picks, ["sisyphus"]);
      assert.match(result.waitingRun, /Rounds 2\/∞/);
      assert.equal(result.invalidBudgetBlocked, true);
      const action = (expectedRevision, action, runId = "run-1") => ({ sessionId: "session-1", runId, expectedRevision, action });
      assert.deepEqual(result.runResolve, [action(3, "approve")]);
      assert.deepEqual(result.runControl, [action(4, "pause"), action(10, "resume"), action(10, "stop"), action(20, "remove", "run-2")]);
      assert.deepEqual(result.runUpdate, [{ sessionId: "session-1", runId: "run-1", expectedRevision: 9,
        input: "Review the docs too", budget: { maxTurns: 40, maxTokens: 200000 },
      }]);
      assert.equal(result.directory, modes);
      assert.deepEqual(result.tabs, ["Mode", "Prompt", "Subagents", "Skills"]);
      assert.equal(result.detailReplacesCatalog, true);
      assert.equal(result.modeOnly, true);
      assert.equal(result.promptOnly, true);
      assert.equal(result.roleReplacesList, true);
      assert.equal(result.source, BUNDLE);
      assert.equal(result.prompt, PROMPT);
      assert.equal(result.globalDefault, "false");
      assert.deepEqual(result.legacyTabs, ["Mode"]);
      assert.equal(result.legacyErrorsBlockSave, true);
      assert.equal(result.legacySource, LEGACY_SOURCE);
      assert.deepEqual(result.restore, ["goal"]);
    });

    await t.test("first Save creates YAML and Duplicate copies via the host without flattening", async () => {
      assert.deepEqual(result.newTabs, result.tabs);
      assert.equal(result.newDuplicateDisabled, true);
      assert.equal(result.newBlankPromptBlocked, true);
      assert.equal(await readFile(join(modes, "legacy-copy/mode.md"), "utf8"), LEGACY_SOURCE.replace("name: legacy-review", "name: legacy-copy"));
      assert.equal(result.newCanSave, true);
      assert.equal(result.newHasPrompt, true);
      assert.match(result.newReopened, /^name: my-mode\n/);
      assert.match(result.newReopened, /^promptFile: prompts\/mode.md$/m);
      assert.ok((await readFile(join(modes, "my-mode/prompts/mode.md"), "utf8")).trim());
      assert.deepEqual(result.copyCalls, [{ fromId: "sisyphus", toId: "sisyphus-copy" }]);
      assert.equal(result.copyWasNotWritten, true);
      assert.equal(result.copyConflict, "sisyphus-copy");
      assert.deepEqual(result.modeAfterStaleCopy, ["my-mode", result.newReopened]);
      assert.equal(await readFile(join(modes, "occupied/notes.md"), "utf8"), NOTE);
      await assert.rejects(readFile(join(modes, "occupied/mode.yaml")), { code: "ENOENT" });
      assert.equal(result.copyTakenDisabled, true);
      assert.equal(result.copyGlobal, "true");
      assert.match(result.copyMap, /^name: sisyphus-copy\n/);
      assert.equal(result.copyPrompt, PROMPT);
      assert.deepEqual(result.copyRoles, ["agents/oracle.agent.md", "agents/fixer.agent.md"]);
      assert.equal(await readFile(join(copy, "prompts/orchestrator.md"), "utf8"), PROMPT);
      assert.equal(await readFile(join(copy, "agents/fixer.agent.md"), "utf8"), FIXER);
      assert.equal(await readFile(join(copy, "templates/report.md"), "utf8"), "Private report template.\n");
      assert.equal(await readFile(join(original, "agents/oracle.agent.md"), "utf8"), ORACLE);
      assert.equal(result.noUnmanagedWrite, true);
      assert.equal(await readFile(join(original, "notes.md"), "utf8"), NOTE);
      await assert.rejects(readFile(join(copy, "notes.md")), { code: "ENOENT" });
    });

    await t.test("primary model and alternative thinking persist in only the edited role", async () => {
      assert.equal(result.roleInitialModel, "claude-opus-4");
      assert.equal(result.roleModelReopened, "gpt-5");
      assert.equal(result.fallbackThinkingReopened, "medium");
      assert.equal(result.roleSelectionCleared, true);
      const role = await readFile(join(copy, "agents/oracle.agent.md"), "utf8");
      assert.match(role, /^model: openai\/gpt-5$/m);
      assert.match(role, /^fallbackModels: \[anthropic\/claude-sonnet-4, openai\/gpt-5-mini\]$/m);
      assert.match(role, /^fallbackThinkingLevels: \[medium, inherit\]$/m);
      assert.match(role, /^thinkingLevel: high$/m);
      assert.match(role, /^tools: \[inherit\]$/m);
      assert.doesNotMatch(result.copyMap, /^model:/m);
    });

    await t.test("opening and toggling mode skills preserves other choices and newer selections", async () => {
      assert.equal(result.skillsDirectory, join(original, "skills"));
      assert.equal(result.skillLabel, true);
      assert.deepEqual(result.skillsOpened, [join(original, "skills")]);
      assert.equal(result.skillInitiallyOn, "true");
      assert.deepEqual(result.skillPatches, [
        { id: "sisyphus", disabledSkills: ["not-installed", "verify-delivery"] },
        { id: "sisyphus", disabledSkills: ["not-installed"] },
      ]);
      assert.equal(result.promptAfterToggle, "Unsaved prompt edit");
      assert.equal(result.skillReenabled, "true");
      assert.deepEqual(result.modeAfterStaleWrite, ["my-mode", result.newReopened]);
      assert.deepEqual(result.modeAfterStaleRead, ["sisyphus-copy", result.copyMap]);
      assert.deepEqual(result.afterStaleSkills, ["my-mode", join(modes, "my-mode/skills"), false]);
      assert.equal(await readFile(join(original, SKILL_DIR, "SKILL.md"), "utf8"), SKILL_DOC);
      assert.equal(await readFile(join(original, SKILL_DIR, "guides/checklist.md"), "utf8"), SKILL_RESOURCE);
    });

    await t.test("Duplicate also retains the private skill document and its nested resource", async () => {
      assert.equal(result.copiedSkillEnabled, "true");
      assert.equal(await readFile(join(copy, SKILL_DIR, "SKILL.md"), "utf8"), SKILL_DOC);
      assert.equal(await readFile(join(copy, SKILL_DIR, "guides/checklist.md"), "utf8"), SKILL_RESOURCE);
      assert.deepEqual(await readFile(join(copy, SKILL_DIR, "assets/raw.bin")), SKILL_BYTES);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
