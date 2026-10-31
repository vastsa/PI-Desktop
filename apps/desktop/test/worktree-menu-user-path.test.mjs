import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

// PRD R6 / AC9: the project menu greys out "New isolated session" with the
// reason for a project that cannot host a worktree, and creates the session
// for one that can. Rendered in a real DOM so the probe effect runs.

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
import { SidebarMenuPanel } from "../../apps/desktop/src/components/SidebarMenuPanel";
import { sidebarMenuAction, sidebarMenuSubmenu } from "../../apps/desktop/src/lib/sidebar-menu";
import { WorktreeBadge, useWorktreeProjectMenuItems, useWorktreeSessionMenuItems } from "../../apps/desktop/src/features/worktree/WorktreeSidebarParts";
import { WorktreeBehindWatcher } from "../../apps/desktop/src/features/worktree/WorktreeBehind";
import { WorktreeMergeDialog } from "../../apps/desktop/src/features/worktree/WorktreeMergeDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const probes = {
  "/plain": { available: false, errorCode: "WORKTREE_NOT_GIT", message: "raw" },
  "/odd": { available: false, errorCode: "WORKTREE_INTERNAL", message: "git exploded" },
  "/repo": { available: true, uncommittedChanges: false },
};
const pending = [];
const behind = { stale: 2, current: 0 };
const synced = [];
let behindAllCalls = 0;
window.piDesktop = { platform: "linux", on() { return () => {}; },
  invoke(channel, payload) {
    if (channel === IPC.invoke.worktreeBehind) return Promise.resolve({ ok: true, data: behind[payload.sessionId] });
    if (channel === IPC.invoke.worktreeBehindAll) {
      behindAllCalls += 1;
      return Promise.resolve({ ok: true, data: { counts: { ...behind }, statusesChanged: false } });
    }
    if (channel === IPC.invoke.worktreeSync) {
      synced.push(payload.sessionId);
      const commits = behind[payload.sessionId];
      behind[payload.sessionId] = 0;
      return Promise.resolve({ ok: true, data: { result: "synced", commits } });
    }
    if (channel === IPC.invoke.worktreePreview) {
      return Promise.resolve({ ok: true, data: { branch: "pi-desktop/s1", ownerBranch: "main",
        commits: [{ sha: "abc", subject: "edit f" }], files: [{ status: "M", path: "f.txt", uncommitted: false }],
        conflict: false, previewToken: "t" } });
    }
    if (channel !== IPC.invoke.worktreeProbe) throw new Error("Unexpected IPC " + channel);
    return new Promise((resolve) => pending.push(() => resolve({ ok: true, data: probes[payload.projectPath] })));
  } };
const created = [];
const toasts = [];
useAppStore.setState({
  newSession: async (options) => { created.push(options); },
  showToast: (message) => { toasts.push(message); },
  refreshSessions: async () => {},
});
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
const item = () => document.querySelector('[data-action="new-isolated-session"]');
const reason = () => document.querySelector("[data-worktree-unavailable]");
/*
  The sidebar's rows are menu data now, so these fixtures render the item list
  the way the sidebar menu panel does: one button per row, the availability
  reason attached to the disabled row it explains.
*/
const ProjectItems = ({ projectPath, projectName, onDone }) => {
  const items = useWorktreeProjectMenuItems({ projectPath, projectName, onDone });
  return React.createElement(React.Fragment, null, items.map((entry) =>
    React.createElement(React.Fragment, { key: entry.id },
      React.createElement("button", { type: "button", role: "menuitem",
        "data-action": entry.id, disabled: entry.disabled,
        "aria-busy": entry.busy || undefined,
        "aria-describedby": entry.describedBy, title: entry.title,
        onClick: entry.onSelect },
        entry.icon,
        React.createElement("span", { className: "sidebar-menu-label" }, entry.label)),
      entry.disabled && entry.describedBy
        ? React.createElement("p", { id: entry.describedBy, "data-worktree-unavailable": "" }, entry.title)
        : null)));
};
const SessionItems = ({ sessionId, title, running, worktree, onDone }) => {
  const items = useWorktreeSessionMenuItems({ sessionId, title, running, worktree, onDone });
  return React.createElement(React.Fragment, null, items.map((entry) =>
    React.createElement("button", { key: entry.id, type: "button", role: "menuitem",
      "data-action": entry.id, disabled: entry.disabled,
      "aria-busy": entry.busy || undefined, title: entry.title,
      onClick: entry.onSelect },
      entry.icon,
      React.createElement("span", { className: "sidebar-menu-label" }, entry.label))));
};
const rootNode = createRoot(document.getElementById("root"));
function show(projectPath) {
  flushSync(() => rootNode.render(React.createElement(ProjectItems,
    { projectPath, projectName: "P", onDone() {} })));
}
async function answer() {
  while (pending.length) pending.shift()();
  await settle();
  // The row's own action probes again; drain whatever that queued.
  while (pending.length) pending.shift()();
  await settle();
}
window.menuProbe = async () => {
  show("/plain");
  check(item().disabled, "item must be disabled while the probe runs");
  check(!reason(), "no reason before the probe answers");
  await answer();
  check(item().disabled, "a non-git project must keep the item disabled");
  check(reason()?.textContent === i18n.t("worktree.errors.notGit"), "missing localized reason");
  check(item().getAttribute("aria-describedby") === reason().id, "reason not linked to the item");
  item().click();
  check(created.length === 0, "a disabled item created a session");

  show("/odd");
  await answer();
  check(reason()?.textContent === "git exploded", "unknown codes must show the host message");

  show("/repo");
  check(item().disabled, "switching project re-probes");
  await answer();
  check(!item().disabled && !reason(), "a git project must enable the item");
  const setupCommandItem = document.querySelector('[data-action="worktree-setup-command"]');
  check(
    setupCommandItem?.querySelector(".sidebar-menu-label")?.textContent === i18n.t("worktree.setupCommand.menu"),
    "setup command label must use the shrinkable text container",
  );
  check(setupCommandItem?.getAttribute("title") === i18n.t("worktree.setupCommand.menu"), "full label must remain available on hover");
  item().click();
  await answer();
  await settle();
  check(JSON.stringify(created) === JSON.stringify([{ projectPath: "/repo", isolated: true }]), "session not created: " + JSON.stringify(created));
  check(toasts.length === 0, "unexpected toast " + JSON.stringify(toasts));
  flushSync(() => rootNode.unmount());

  // The app renders under StrictMode, which mounts every effect twice; the
  // merge preview must still leave the loading state.
  const dialogRoot = createRoot(document.getElementById("root"));
  flushSync(() => dialogRoot.render(React.createElement(React.StrictMode, null,
    React.createElement(WorktreeMergeDialog, { sessionId: "s1", title: "Task", onClose() {} }))));
  await settle();
  const confirm = document.querySelector('[data-action="worktree-merge-confirm"]');
  check(confirm && !confirm.disabled, "merge preview stuck loading under StrictMode");
  check(document.body.textContent.includes("f.txt"), "preview files not shown");
  flushSync(() => dialogRoot.unmount());

  // The sidebar marker: the watcher reads every session's count in the
  // background, the badge shows it, and a sync clears it.
  const at = "2020-01-01T00:00:00Z";
  const worktreeOf = (id) => ({ branch: "pi-desktop/" + id, status: "active", setupStatus: "none" });
  useAppStore.setState({ sessions: [
    { id: "stale", title: "Stale", createdAt: at, updatedAt: at, worktree: worktreeOf("stale") },
    { id: "current", title: "Current", createdAt: at, updatedAt: at, worktree: worktreeOf("current") },
  ] });
  const sidebarRoot = document.createElement("div");
  document.body.appendChild(sidebarRoot);
  const rows = createRoot(sidebarRoot);
  flushSync(() => rows.render(React.createElement(React.StrictMode, null,
    React.createElement(WorktreeBehindWatcher),
    React.createElement("div", { "data-row": "stale" }, React.createElement(WorktreeBadge, { sessionId: "stale", worktree: worktreeOf("stale") })),
    React.createElement("div", { "data-row": "current" }, React.createElement(WorktreeBadge, { sessionId: "current", worktree: worktreeOf("current") })))));
  await settle();
  const marker = (id) => sidebarRoot.querySelector('[data-row="' + id + '"] [data-worktree-behind]');
  check(marker("stale")?.textContent === i18n.t("worktree.badge.behind", { count: 2 }), "stale session has no behind marker");
  check(!marker("current"), "an up-to-date session must have no marker");

  // "Sync from project" shows how far behind the session is and syncs it.
  const menuRoot = createRoot(document.getElementById("root"));
  const sessionMenu = (sessionId) => flushSync(() => menuRoot.render(React.createElement(React.StrictMode, null,
    React.createElement(SessionItems, { sessionId, title: "Task", running: false, onDone() {},
      worktree: { branch: "pi-desktop/" + sessionId, status: "active", setupStatus: "none" } }))));
  const syncItem = () => document.querySelector('[data-action="worktree-sync"]');
  sessionMenu("current");
  await settle();
  check(syncItem().disabled, "an up-to-date session must not offer a sync");
  sessionMenu("stale");
  await settle();
  check(!syncItem().disabled, "a session behind the project must offer a sync");
  check(syncItem().textContent.includes(i18n.t("worktree.sync.menuBehind", { count: 2 })), "missing behind count");
  toasts.length = 0;
  syncItem().click();
  await settle();
  check(JSON.stringify(synced) === JSON.stringify(["stale"]), "sync not requested: " + JSON.stringify(synced));
  check(toasts[0] === i18n.t("worktree.sync.success", { count: 2 }), "missing sync toast: " + JSON.stringify(toasts));
  await settle();
  check(behindAllCalls >= 2, "a sync must re-read the counts");
  check(!marker("stale"), "the marker must clear after the sync");
  flushSync(() => menuRoot.unmount());
  const submenuHost = document.createElement("div");
  document.body.appendChild(submenuHost);
  const submenuRoot = createRoot(submenuHost);
  const selectedSubmenuActions = [];
  const submenuContent = {
    label: "Session actions",
    items: [sidebarMenuSubmenu({
      id: "git",
      label: "Git",
      items: [
        sidebarMenuAction({
          id: "fork",
          label: "Branch from here",
          onSelect: () => selectedSubmenuActions.push("fork"),
        }),
        sidebarMenuAction({
          id: "reveal",
          label: "Show worktree folder",
          onSelect: () => selectedSubmenuActions.push("reveal"),
        }),
      ],
    })],
  };
  flushSync(() => submenuRoot.render(React.createElement(SidebarMenuPanel, {
    content: submenuContent,
    position: { top: 90, left: Math.max(8, window.innerWidth - 230) },
    onKeyDown() {},
  })));
  const submenuTrigger = submenuHost.querySelector('[data-submenu-trigger="git"]');
  check(submenuTrigger?.getAttribute("aria-expanded") === "false", "submenu starts closed");
  submenuTrigger.dispatchEvent(new PointerEvent("pointerover", {
    bubbles: true,
    pointerType: "mouse",
  }));
  await settle();
  check(submenuTrigger.getAttribute("aria-expanded") === "true", "hover opens the submenu");
  // The child panel is portaled to the body, so it is a sibling of the host
  // rather than its descendant (#1896).
  check(document.querySelector('#sidebar-submenu-git [data-action="fork"]'), "hover shows child actions");

  // Travel from the menu onto its portaled child: the pointer leaves the root
  // menu's subtree, but it is still inside the menu the user sees (#1896).
  const forkRow = document.querySelector('#sidebar-submenu-git [data-action="fork"]');
  submenuTrigger.dispatchEvent(new PointerEvent("pointerout", {
    bubbles: true,
    pointerType: "mouse",
    relatedTarget: forkRow,
  }));
  await settle();
  check(
    document.querySelector("#sidebar-submenu-git") && submenuTrigger.getAttribute("aria-expanded") === "true",
    "moving onto the portaled submenu keeps it open",
  );
  // Leaving both panels still closes it.
  forkRow.dispatchEvent(new PointerEvent("pointerout", {
    bubbles: true,
    pointerType: "mouse",
    relatedTarget: document.body,
  }));
  await settle();
  check(!document.querySelector("#sidebar-submenu-git"), "leaving both panels closes the child menu");

  submenuTrigger.focus();
  submenuTrigger.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    cancelable: true,
  }));
  await settle();
  check(document.activeElement?.getAttribute("data-action") === "fork", "ArrowRight enters the submenu");
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  await settle();
  check(!document.querySelector("#sidebar-submenu-git"), "Escape closes the child menu");
  check(document.activeElement === submenuTrigger, "closing restores focus to its trigger");

  submenuTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await settle();
  check(submenuTrigger.getAttribute("aria-expanded") === "true", "click opens the submenu without hover");
  document.querySelector('#sidebar-submenu-git [data-action="reveal"]').click();
  check(JSON.stringify(selectedSubmenuActions) === JSON.stringify(["reveal"]), "child action executes");
  flushSync(() => submenuRoot.unmount());
  submenuHost.remove();
  flushSync(() => rows.unmount());
  return { passed: true };
};
`;

test("sidebar submenu opens on hover, click, and keyboard; worktree actions still work", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.worktree-menu-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      // Development React, like `pnpm dev`: StrictMode double-mounts effects.
      define: { "process.env.NODE_ENV": '"development"' },
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
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("MENU_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.menuProbe()")));
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
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("MENU_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("MENU_PROBE ".length)), { passed: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
