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
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import { ProjectMemoryDialog } from "../../apps/desktop/src/components/ProjectMemoryDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: Object.fromEntries(["en", "zh-CN"].map((locale) =>
    [locale, { translation: flattenCatalog(catalogs[locale]) }])),
  interpolation: { escapeValue: false } });
const groups = [
  { id: "alpha", name: "Alpha", primaryPath: "/fixture/alpha", roots: [{ path: "/fixture/alpha" }] },
  { id: "beta", name: "Beta", primaryPath: "/fixture/beta", roots: [{ path: "/fixture/beta" }, { path: "/fixture/assets" }] },
  { id: "legacy:/fixture/old", name: "Old", primaryPath: "/fixture/old", legacy: true, roots: [{ path: "/fixture/old" }] },
];
const memories = {
  alpha: { content: "Alpha private note", entries: [{ id: "a", title: "Alpha", content: "Alpha private note" }] },
  beta: { content: "Beta shared note", entries: [{ id: "b", title: "Beta", content: "Beta shared note" }] },
  "/fixture/old": { content: "Legacy note" },
};
const calls = [];
let failList = false;
let failSave = false;
let deferList = false;
const pendingLists = [];
window.piDesktop = { platform: "win32", on() { return () => {}; },
  invoke(channel, payload) {
    calls.push({ channel, payload });
    const ok = (data) => Promise.resolve({ ok: true, data });
    const fail = (message) => Promise.resolve({ ok: false, error: { code: "INTERNAL", message } });
    if (channel === IPC.invoke.projectGroupList) {
      if (deferList) return new Promise(resolve => pendingLists.push(() => resolve({ ok: true, data: { groups } })));
      return failList ? fail("Cannot load projects") : ok({ groups });
    }
    if (channel === IPC.invoke.projectGroupMemoryGet || channel === IPC.invoke.projectMemoryGet) {
      const key = payload.groupId ?? payload.projectPath;
      if (!memories[key]) throw new Error("Unexpected memory target: " + key);
      return ok({ memory: structuredClone(memories[key]) });
    }
    if (channel === IPC.invoke.projectGroupMemorySave || channel === IPC.invoke.projectMemorySave) {
      if (failSave) return fail("Cannot save memory");
      const key = payload.groupId ?? payload.projectPath;
      memories[key] = { entries: structuredClone(payload.entries), content: payload.entries.map(e => e.content).join("\n") };
      return ok({ memory: structuredClone(memories[key]) });
    }
    if (channel === IPC.invoke.updatesGetState) return ok(null);
    if (channel === IPC.invoke.worktreeProbe) return ok({ available: false, errorCode: "WORKTREE_NOT_GIT" });
    throw new Error("Unexpected IPC: " + channel);
  } };
useAppStore.setState({
  page: "chat", activeSessionId: "active-alpha", workspace: { name: "Alpha", path: "/fixture/alpha" },
  openProjectPaths: ["/fixture/alpha", "/fixture/beta", "/fixture/old"],
  openProjects: groups.map(g => ({ name: g.name, path: g.primaryPath })),
  activeProjectPath: "/fixture/alpha", sessions: [], projectSort: "name", projectMeta: {},
});
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(React.StrictMode, null,
  React.createElement(Sidebar, { onToggleSidebar() {}, sidebarToggleShortcut: "", sidebarWidth: 260,
    onWidthChange() {}, onWidthCommit() {}, onResizeCollapse() {} }))));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) {
  for (let n = 0; n < 120; n += 1) { if (predicate()) return; await frame(); }
  throw new Error(message + " body=" + document.body.textContent);
}
const dialog = () => document.querySelector(".project-memory-dialog");
function button(key) {
  return [...dialog().querySelectorAll("button")].find(b => b.textContent.trim() === i18n.t(key) ||
    (key === "project.memorySave" && b.textContent.trim() === i18n.t("project.memorySaving")));
}
function click(node) { check(node, "Missing click target"); flushSync(() => node.click()); }
function edit(node, value) {
  const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
  flushSync(() => node.dispatchEvent(new Event("input", { bubbles: true })));
}
async function open(name, contextMenu = false) {
  const title = [...document.querySelectorAll(".project-toggle")].find(b => b.getAttribute("aria-label") === name);
  check(title, "Project header missing: " + name);
  const header = title.closest(".sidebar-session-group-header");
  if (contextMenu) {
    flushSync(() => header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
  } else click(header.querySelector(".project-more"));
  const item = document.querySelector('[data-action="project-memory"]');
  check(item?.textContent.trim() === i18n.t("project.editMemory"), "Project memory menu entry missing or untranslated");
  check(item.getAttribute("role") === "menuitem", "Memory action lacks menu semantics");
  click(item);
  check(!document.querySelector('[role="menu"]'), "Memory action left the menu open");
  await until(() => dialog() && !button("project.memoryAdd").disabled, "Memory editor did not load");
  check(dialog().textContent.includes(name), "Wrong project name in editor");
}
const saveCalls = () => calls.filter(c => c.channel === IPC.invoke.projectGroupMemorySave || c.channel === IPC.invoke.projectMemorySave);
const saved = () => button("project.memorySave").disabled && button("project.memorySave").textContent.trim() === i18n.t("project.memorySave");
function unchangedNavigation() {
  const s = useAppStore.getState();
  check(s.page === "chat" && s.activeSessionId === "active-alpha" && s.workspace.path === "/fixture/alpha",
    "Editing memory changed the visible conversation or workspace");
}
window.projectMemoryProbe = async () => {
  await settle();
  await open("Beta");
  check(dialog().querySelector("textarea").value === "Beta shared note", "Group memory was not loaded");
  edit(dialog().querySelector("textarea"), "Updated beta note");
  click(button("project.memoryAdd"));
  const cards = dialog().querySelectorAll('[role="listitem"]');
  edit(cards[1].querySelector("input"), "Second note");
  edit(cards[1].querySelector("textarea"), "Additional beta context");
  click(button("project.memorySave"));
  await until(() => saveCalls().length === 1 && saved(), "Save did not complete");
  check(saveCalls()[0].payload.groupId === "beta", "Saved group memory through a path or wrong group");
  check(useAppStore.getState().toasts.some(t => t.message === i18n.t("project.memorySaved")), "Missing success feedback");
  unchangedNavigation();
  click(button("settings.cancel"));
  await open("Beta", true);
  check(dialog().querySelectorAll("textarea").length === 2, "Saved cards did not reopen");
  check(dialog().querySelector("textarea").value === "Updated beta note", "Saved edit missing");
  click(dialog().querySelector(".project-memory-remove"));
  click(button("project.memorySave"));
  await until(() => saveCalls().length === 2 && saved(), "Removal not saved");
  click(button("settings.cancel"));

  await open("Alpha");
  check(dialog().querySelector("textarea").value === "Alpha private note", "Memory leaked between groups");
  edit(dialog().querySelector("textarea"), "Unsaved alpha note");
  await i18n.changeLanguage("zh-CN");
  await settle();
  check(dialog().querySelector("textarea").value === "Unsaved alpha note", "Language change discarded the draft");
  await i18n.changeLanguage("en");
  await settle();
  click(button("settings.cancel"));
  check(saveCalls().length === 2, "Cancel saved a draft");
  await open("Alpha");
  check(dialog().querySelector("textarea").value === "Alpha private note", "Cancel overwrote saved memory");
  click(button("settings.cancel"));

  await i18n.changeLanguage("zh-CN");
  await open("Old");
  check(dialog().querySelector("textarea").value === "Legacy note", "Legacy memory did not load as a card");
  edit(dialog().querySelector("textarea"), "Updated legacy note");
  failSave = true;
  click(button("project.memorySave"));
  await until(() => useAppStore.getState().toasts.some(t => t.message.includes("Cannot save memory")), "Save error not reported");
  await until(() => !button("project.memorySave").disabled, "Failed save cannot be retried");
  failSave = false;
  click(button("project.memorySave"));
  await until(() => memories["/fixture/old"].content === "Updated legacy note", "Legacy save did not use its path");
  await settle();
  click(button("settings.cancel"));
  unchangedNavigation();

  failList = true;
  const title = [...document.querySelectorAll(".project-toggle")].find(b => b.getAttribute("aria-label") === "Beta");
  click(title.closest(".sidebar-session-group-header").querySelector(".project-more"));
  click(document.querySelector('[data-action="project-memory"]'));
  await until(() => useAppStore.getState().toasts.some(t => t.message.includes("Cannot load projects")), "Load error not reported");
  check(button("project.memoryAdd").disabled && button("project.memorySave").disabled, "Failed identity resolution allowed editing");
  click(button("settings.cancel"));
  unchangedNavigation();

  // A closed editor must not apply a late identity lookup to the next editor.
  failList = false;
  deferList = true;
  const alphaTitle = [...document.querySelectorAll(".project-toggle")].find(b => b.getAttribute("aria-label") === "Alpha");
  click(alphaTitle.closest(".sidebar-session-group-header").querySelector(".project-more"));
  click(document.querySelector('[data-action="project-memory"]'));
  check(button("project.memoryAdd").disabled, "Editing enabled before identity resolved");
  click(button("settings.cancel"));
  deferList = false;
  await open("Beta");
  const beforeLateResponse = calls.length;
  pendingLists.splice(0).forEach(answer => answer());
  await settle();
  check(dialog().querySelector("textarea").value === "Additional beta context", "Late response overwrote the next project");
  check(!calls.slice(beforeLateResponse).some(c => c.channel === IPC.invoke.projectGroupMemoryGet), "Cancelled lookup started a memory read");
  click(button("settings.cancel"));
  check(!calls.some(c => [IPC.invoke.projectSet, IPC.invoke.projectOpen].includes(c.channel)), "Memory triggered project activation");
  flushSync(() => rootNode.unmount());

  // Settings passes the identity explicitly. Keep its existing group/legacy
  // branches working even when project discovery is unavailable.
  failList = true;
  const editorRoot = createRoot(document.getElementById("root"));
  const listCalls = calls.filter(c => c.channel === IPC.invoke.projectGroupList).length;
  const showEditor = (project) => flushSync(() => editorRoot.render(React.createElement(ProjectMemoryDialog, {
    key: project.path, project, onClose() {}, onSaved() {}, onError(error) { throw error; },
  })));
  showEditor({ name: "Beta", path: "/fixture/beta", groupId: "beta" });
  await until(() => dialog() && !button("project.memoryAdd").disabled, "Settings group editor did not load");
  check(dialog().querySelector("textarea").value === "Additional beta context", "Sidebar and Settings used different memory");
  showEditor({ name: "Old", path: "/fixture/old", groupId: "legacy:/fixture/old", legacy: true });
  await until(() => dialog() && !button("project.memoryAdd").disabled, "Settings legacy editor did not load");
  check(dialog().querySelector("textarea").value === "Updated legacy note", "Settings legacy memory changed");
  check(calls.filter(c => c.channel === IPC.invoke.projectGroupList).length === listCalls, "Explicit identity needlessly rediscovered projects");
  flushSync(() => editorRoot.unmount());
  return { passed: true };
};
`;

test("sidebar project memory: open, edit, save, reopen, isolate, cancel, and recover", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-project-memory-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      loader: { ".png": "dataurl" },
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
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", event => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("PROJECT_MEMORY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.projectMemoryProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", chunk => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find(item => item.startsWith("PROJECT_MEMORY_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("PROJECT_MEMORY_PROBE ".length)), { passed: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
