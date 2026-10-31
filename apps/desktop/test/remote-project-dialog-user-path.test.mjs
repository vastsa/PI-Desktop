import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
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
import { ProjectCreateDialog } from "../../apps/desktop/src/components/ProjectCreateDialog";
import { RemoteHostsPage } from "../../apps/desktop/src/components/settings/RemoteHostsPage";
import { FilesTab } from "../../apps/desktop/src/components/workpanel/FilesTab";
import { ProjectEditDialog } from "../../apps/desktop/src/components/ProjectEditDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { remoteEn } from "../../apps/desktop/src/locales/remote";
import "../../apps/desktop/src/styles/project-create-dialog.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en), remote: remoteEn } },
  interpolation: { escapeValue: false } });
const calls = [];
const unexpectedCalls = [];
let releaseOldBrowse;
let releaseCreate;
let releaseOldFile;
let savedGroup;
const group = { id: "local-group", name: "My server app", primaryPath: "remote-project:local-group", roots: [{ id: "root", path: "remote-project:local-group", position: 0 }], remote: { hostKey: "h2", path: "/home/user/app" }, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
window.piDesktop = { platform: "darwin", channels: IPC, on() { return () => {}; },
 async invoke(channel, input) {
  calls.push({ channel, input });
  const data = await (async () => { switch (channel) {
   case IPC.invoke.remoteHostList: return { hosts: [{ hostKey: "h1", label: "Server 1", connected: true }, { hostKey: "h2", label: "Server 2", connected: true }, { hostKey: "offline", label: "Offline", connected: false }] };
   case IPC.invoke.remoteHostBrowseProjects:
    if (input.hostKey === "h1") return new Promise((resolve) => { releaseOldBrowse = () => resolve({ path: "/old", entries: [{ name: "stale", path: "/old/stale" }] }); });
    if (input.path === "/missing") throw Object.assign(new Error("private diagnostic ppt1.secret"), { errorCode: "REMOTE_PATH_NOT_FOUND" });
    return { path: input.path ?? "/home/user", parent: input.path === "/home/user/app" ? "/home/user" : "/home", entries: input.path === "/home/user/app" ? [] : [{ name: "app", path: "/home/user/app" }] };
   case IPC.invoke.projectGroupCreateRemote: return new Promise((resolve) => { releaseCreate = () => resolve({ group: { ...group, name: input.name } }); });
   case IPC.invoke.projectSet: return { workspace: { path: input, name: group.name, remote: group.remote, projectGroup: group } };
   case IPC.invoke.appGetOnboarding: return { completed: true };
   case IPC.invoke.fsList: return { entries: [{ name: "README.md", kind: "file", size: 11 }, { name: "old.txt", kind: "file", size: 9 }] };
   case IPC.invoke.fsRead:
    if (input.path === "old.txt") return new Promise((resolve) => { releaseOldFile = () => resolve({ kind: "text", content: "old bytes", size: 9 }); });
    return { kind: "text", content: "remote file", size: 11 };
   case IPC.invoke.projectGroupList: return { groups: [group] };
   case IPC.invoke.projectGroupRename: return { group: { ...group, name: input.name } };
   default: unexpectedCalls.push(channel); throw new Error("Unexpected IPC: " + channel);
  } })();
  return { ok: true, data };
 }
};
const view = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) { for (let n=0;n<120;n++) { if (predicate()) return; await frame(); } throw new Error(message + " body=" + document.body.textContent + " calls=" + JSON.stringify(calls)); }
const button = (label, scope = document) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
function choose(node, value) { flushSync(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(node, value); node.dispatchEvent(new Event("change", { bubbles: true })); }); }
function input(node, value) { flushSync(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
const picker = () => document.querySelector(".remote-folder-dialog");
window.remoteProjectProbe = async () => {
 useAppStore.setState({ workspace: { path: "/local/app", name: "app" }, activeProjectPath: "/local/app", openProjectPaths: ["/local/app"], openProjects: [{ path: "/local/app", name: "app" }], sessions: [], page: "settings" });
 flushSync(() => view.render(React.createElement(React.Fragment, null, React.createElement(RemoteHostsPage), React.createElement(ProjectCreateDialog))));
 await until(() => document.querySelectorAll(".settings-remote-host-card").length === 3, "remote host inventory did not load");
 const hostCard = [...document.querySelectorAll(".settings-remote-host-card")].find((card) => card.textContent.includes("Server 2"));
 check(hostCard, "requested host card missing");
 const createButton = button("New project", hostCard);
 check(createButton, "host card has no new project action");
 createButton.click();
 await until(() => document.querySelector(".project-create-dialog") && document.querySelector("select")?.value === "h2", "new project did not preselect remote source and host");
 check(document.querySelector('.project-create-dialog [data-project-source="remote"]')?.getAttribute("aria-pressed") === "true", "remote project source was not selected");
 check(!document.querySelector(".remote-host-workbench"), "remote host page still opens a session workbench");
 check(!calls.some((entry) => entry.channel === IPC.invoke.remoteHostSessions), "opening project management listed remote sessions");
 input(document.querySelector("#project-create-name"), "My server app");
 check(document.querySelector("#project-create-name").value === "My server app", "remote source lost editable local name");
 check(document.querySelector('option[value="offline"]'), "disconnected paired host not offered");
 check(document.querySelectorAll("select").length === 1, "host project catalog still required");
 check(!calls.some((entry) => entry.channel === IPC.invoke.remoteHostProjects), "host project catalog was fetched");
 check(!calls.some((entry) => entry.channel === IPC.invoke.remoteHostBrowseProjects), "browse loaded inside project form");
 choose(document.querySelector("select"), "h1");
 button("Browse folders").click();
 await until(() => releaseOldBrowse && picker(), "folder dialog missing");
 check(document.querySelector('.project-create-dialog').inert, "project form was interactive behind folder dialog");
 picker().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
 await until(() => !picker(), "Escape did not close picker"); await settle();
 check(document.querySelector('.project-create-dialog'), "Escape closed parent project dialog");
 check(document.activeElement === button("Browse folders"), "cancel did not restore browse focus");
 choose(document.querySelector("select"), "offline");
 button("Browse folders").click();
 await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/home/user", "offline paired host did not browse after restore");
 check(calls.some((entry) => entry.channel === IPC.invoke.remoteHostBrowseProjects && entry.input.hostKey === "offline"), "offline browse did not reach recovery entry");
 button("Cancel", picker()).click();
 await until(() => !picker(), "offline browse cancel failed");
 choose(document.querySelector("select"), "h2");
 button("Browse folders").click();
 await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/home/user", "new host did not load");
 releaseOldBrowse(); await settle();
 check(!document.body.textContent.includes("stale"), "late host browse replaced current directory");
 const dialog = picker();
 check(dialog.scrollWidth <= dialog.clientWidth, "folder dialog overflows narrow window");
 const controls = [...dialog.querySelectorAll('input:not([disabled]),button:not([disabled])')];
 controls.at(-1).focus(); controls.at(-1).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
 check(document.activeElement === controls[0], "folder dialog focus trap failed");
 dialog.querySelector('[aria-label="Open app"]').click();
 await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/home/user/app", "directory navigation failed");
 button("Parent directory", picker()).click();
 await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/home/user", "parent navigation failed");
 input(picker().querySelector("input"), "/missing");
 picker().querySelector('form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await until(() => picker()?.querySelector('[role="alert"]')?.textContent.includes("remote directory"), "safe directory error missing");
 check(!document.body.textContent.includes("ppt1.secret"), "raw remote diagnostic leaked");
 check(button("Use this folder", picker()).disabled, "failed directory still selectable");
 input(picker().querySelector("input"), "/home/user/app");
 picker().querySelector('form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/home/user/app", "path navigation failed");
 button("Use this folder", picker()).click();
 await until(() => !picker(), "choose did not close folder dialog"); await settle();
 check(document.querySelector(".remote-project-picker input").value === "/home/user/app", "chosen path not retained");
 check(document.querySelector("#project-create-name").value === "My server app", "folder name overrode local project name");
 check(document.activeElement === button("Browse folders"), "choose did not restore browse focus");
 button("Browse folders").click();
 await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/home/user/app", "picker did not reopen selected folder");
 input(picker().querySelector("input"), "/home/user");
 picker().querySelector('form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/home/user", "reopened path navigation failed");
 check(!releaseCreate, "folder navigation submitted the parent project form");
 button("Cancel", picker()).click(); await until(() => !picker(), "cancel button failed");
 check(document.querySelector(".remote-project-picker input").value === "/home/user/app", "canceled navigation changed selected project folder");
 input(document.querySelector(".remote-project-picker input"), "relative"); await settle();
 check(document.querySelector('button[type="submit"]').disabled, "relative remote path accepted");
 input(document.querySelector(".remote-project-picker input"), "/home/user/app"); await settle();
 const form = document.querySelector(".project-create-dialog form");
 form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await until(() => releaseCreate, "local remote-bound project creation did not start");
 const creations = calls.filter((entry) => entry.channel === IPC.invoke.projectGroupCreateRemote);
 check(creations.length === 1, "duplicate project creation");
 check(creations[0].input.name === "My server app" && creations[0].input.hostKey === "h2" && creations[0].input.path === "/home/user/app", "local name and remote path not saved together");
 releaseCreate();
 await until(() => useAppStore.getState().activeProjectPath === group.primaryPath && !document.querySelector('[role="dialog"]'), "normal project activation failed");
 check(useAppStore.getState().workspace?.path === group.primaryPath && useAppStore.getState().page === "chat", "remote-bound group did not use normal project state");
 check(!calls.some((entry) => [IPC.invoke.remoteHostRegisterProject, IPC.invoke.remoteHostCreateSession].includes(entry.channel)), "remote project/session catalog managed creation");
 flushSync(() => view.render(React.createElement(ProjectEditDialog, { project: { path: group.primaryPath, name: group.name, groupId: group.id }, onClose() {}, onSaved(next) { savedGroup = next; }, onError(error) { throw error; } })));
 await until(() => document.querySelector('#project-edit-name:not([disabled])'), "edit project did not load");
 check(document.querySelector('.project-create-folder-path').textContent === "/home/user/app", "remote folder path not shown");
 check(!document.querySelector('.project-create-add-folder'), "remote project offered native folder picker");
 check(!document.querySelector('.project-edit-dialog').textContent.includes(group.primaryPath), "synthetic identity leaked in project editor");
 input(document.querySelector('#project-edit-name'), "Renamed server app");
 document.querySelector('form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await until(() => savedGroup?.name === "Renamed server app", "remote-bound project rename failed");
 check(calls.some((entry) => entry.channel === IPC.invoke.projectGroupRename && entry.input.name === "Renamed server app"), "rename did not use local project storage");
 check(!calls.some((entry) => entry.channel === IPC.invoke.projectGroupUpdate), "rename sent synthetic folder to local fs validation");
 useAppStore.setState({ activeSessionId: "local-persisted-session" });
 flushSync(() => view.render(React.createElement(FilesTab)));
 await until(() => document.querySelector('.file-tree-name')?.textContent === "README.md", "normal Files list did not load remote workspace");
 [...document.querySelectorAll('.file-tree-name')].find((node) => node.textContent === "old.txt").closest('button').click();
 await until(() => releaseOldFile, "slow remote file read did not begin");
 document.querySelector('[aria-label="' + i18n.t("panel.files.back") + '"]').click();
 await until(() => document.querySelector('.file-tree-name'), "file preview back failed");
 document.querySelector('.file-tree-name').closest('button').click();
 await until(() => document.querySelector('.file-viewer-body')?.textContent.includes("remote file"), "normal file preview did not show remote bytes");
 releaseOldFile(); await settle();
 check(!document.querySelector('.file-viewer-body').textContent.includes("old bytes"), "late remote read replaced newer selected file");
 check(calls.filter((entry) => [IPC.invoke.fsRead, IPC.invoke.fsList].includes(entry.channel)).every((entry) => entry.input.sessionId === "local-persisted-session"), "Files view lost its owning local session");
 check(!document.querySelector('[aria-label="' + i18n.t("panel.files.reveal") + '"]'), "remote file preview offered local Finder reveal");
 flushSync(() => view.unmount());
 check(unexpectedCalls.length === 0, "unexpected IPC calls: " + unexpectedCalls.join(", "));
 return { passed: true };
};
`;

test("remote host page opens a preselected remote project and creates a local project", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.remote-project-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      plugins: [{ name: "vite-url-assets", setup(plugin) {
        plugin.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "url-asset" }));
        plugin.onLoad({ filter: /.*/, namespace: "url-asset" }, () => ({ contents: 'export default "fixture-asset";', loader: "js" }));
      } }],
      loader: { ".css": "empty", ".png": "dataurl", ".gif": "dataurl" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
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
    await writeFile(join(temp, "renderer.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 380, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (...args) => console.log("RENDERER", (args[0].message ?? args[2] ?? "").slice(0, 500)));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("REMOTE_PROJECT_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.remoteProjectProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("REMOTE_PROJECT_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("REMOTE_PROJECT_PROBE ".length)), {
      passed: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
