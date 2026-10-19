import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { createServer } from "vite";

// ADR 0329 renderer surface: badge, menus, create flow, merge failures, and
// the rule that an ordinary "+" never reuses an empty isolated session.

let server;
let modules;
const en = catalogs.en.worktree;

/*
  The worktree rows are menu data now, rendered by the sidebar's own panel.
  This mirror keeps the assertions about those rows in one place.
*/
const renderItems = (items) =>
  items.map((item) =>
    createElement("button", {
      key: item.id,
      type: "button",
      role: "menuitem",
      "data-action": item.id,
      disabled: item.disabled === true,
      "aria-busy": item.busy ? true : undefined,
      title: item.title,
      onClick: item.onSelect,
    }, item.icon, createElement("span", { className: "sidebar-menu-label" }, item.label)));

const SessionItems = (props) =>
  createElement(Fragment, null, renderItems(modules.parts.useWorktreeSessionMenuItems(props)));
const ProjectItems = (props) =>
  createElement(Fragment, null, renderItems(modules.parts.useWorktreeProjectMenuItems(props)));
const DeleteLoss = ({ sessionId }) =>
  createElement(Fragment, null, modules.parts.useWorktreeDeleteLossText(sessionId));

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  modules = {
    sidebar: await server.ssrLoadModule("/src/components/Sidebar.tsx"),
    parts: await server.ssrLoadModule("/src/features/worktree/WorktreeSidebarParts.tsx"),
    actions: await server.ssrLoadModule("/src/features/worktree/worktree-actions.ts"),
    store: await server.ssrLoadModule("/src/stores/app-store.ts"),
    behind: await server.ssrLoadModule("/src/features/worktree/WorktreeBehind.tsx"),
    worktreeUi: await server.ssrLoadModule("/src/features/worktree/worktree-ui-store.ts"),
    shared: await import("@pi-desktop/shared"),
  };
  // Same interpolation setting as the app (main.tsx): React escapes output.
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
});

after(async () => {
  globalThis.document = previousDocument;
  globalThis.window = previousWindow;
  await server?.close();
});

const wrap = (element) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

/** Route renderer `invoke` calls to `handlers[channel]`. */
function stubBridge(handlers) {
  const calls = [];
  globalThis.window = {
    piDesktop: {
      async invoke(channel, payload) {
        calls.push({ channel, payload });
        const handler = handlers[channel];
        if (!handler) return { ok: false, error: { code: "INTERNAL", message: `no stub for ${channel}` } };
        try {
          return { ok: true, data: await handler(payload) };
        } catch (error) {
          return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
        }
      },
    },
  };
  return calls;
}

test("the sidebar badges isolated sessions and leaves ordinary ones unchanged", () => {
  const { Sidebar } = modules.sidebar;
  const { useAppStore } = modules.store;
  const at = "2020-01-01T00:00:00Z";
  const session = (id, worktree) => ({ id, title: id, projectPath: "/open", createdAt: at, updatedAt: at, worktree });
  Object.assign(useAppStore.getInitialState(), {
    sessions: [
      session("plain"),
      session("isolated", { branch: "pi-desktop/a", status: "active", setupStatus: "none" }),
      session("conflicted", { branch: "pi-desktop/b", status: "conflict" }),
      session("vanished", { branch: "pi-desktop/c", status: "missing" }),
      session("broken-setup", { branch: "pi-desktop/d", status: "active", setupStatus: "failed" }),
    ],
    sessionMeta: {},
    projectMeta: {},
    openProjectPaths: ["/open"],
    openProjects: [],
    workspace: null,
    activeProjectPath: null,
    activeSessionId: null,
    selectingSessionId: null,
    page: "chat",
    projectCollapsed: {},
    sessionView: { sort: "recent", archived: false },
  });
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  const html = wrap(
    createElement(Sidebar, {
      collapsed: false,
      onToggle() {},
      sidebarWidth: 275,
      onWidthChange() {},
      onWidthCommit() {},
    }),
  );
  const row = (id) => {
    const start = html.indexOf(`data-sidebar-session-row="${id}"`);
    const next = html.indexOf("data-sidebar-session-row=", start + 1);
    return html.slice(start, next === -1 ? undefined : next);
  };
  assert.doesNotMatch(row("plain"), /thread-item-worktree/);
  assert.match(row("isolated"), /data-worktree-status="active"/);
  assert.ok(row("isolated").includes(en.badge.isolated));
  assert.ok(row("isolated").includes("pi-desktop/a"), "the branch is named in the badge title");
  assert.match(row("conflicted"), /badge-warning[^>]*>Conflict</);
  assert.match(row("vanished"), /badge-error[^>]*>Folder missing</);
  assert.ok(row("broken-setup").includes(en.badge.setupFailed));
});

test("only isolated sessions get worktree menu items, disabled while running or missing", () => {
  const props = { sessionId: "s1", title: "Task", running: false, onDone() {} };
  assert.equal(wrap(createElement(SessionItems, props)), "");

  const idle = wrap(
    createElement(SessionItems, {
      ...props,
      worktree: { branch: "pi-desktop/s1", status: "active", setupStatus: "failed" },
    }),
  );
  assert.match(idle, /data-action="worktree-merge"/);
  assert.doesNotMatch(idle, /data-action="worktree-merge"[^>]*disabled/);
  assert.match(idle, /data-action="worktree-reveal"/);
  assert.match(idle, /data-action="worktree-setup-log"/);
  // "Sync from project" waits for the behind count before it can be used.
  assert.match(idle, /data-action="worktree-sync"[^>]*disabled/);
  assert.ok(idle.includes(en.sync.menu));

  const running = wrap(
    createElement(SessionItems, {
      ...props,
      running: true,
      worktree: { branch: "pi-desktop/s1", status: "active", setupStatus: "none" },
    }),
  );
  assert.match(running, /data-action="worktree-merge"[^>]*disabled/);
  assert.doesNotMatch(running, /worktree-setup-log/);

  const missing = wrap(
    createElement(SessionItems, {
      ...props,
      worktree: { branch: "pi-desktop/s1", status: "missing" },
    }),
  );
  assert.match(missing, /data-action="worktree-merge"[^>]*disabled/);
  assert.match(missing, /data-action="worktree-reveal"[^>]*disabled/);

  const project = wrap(
    createElement(ProjectItems, { projectPath: "/p", projectName: "P", onDone() {} }),
  );
  assert.ok(project.includes(en.newIsolatedSession));
  assert.ok(project.includes(en.setupCommand.menu));
  // Before the probe answers the item cannot be clicked.
  assert.match(project, /data-action="new-isolated-session"[^>]*disabled/);
});

test("the isolated-session menu item explains why a project cannot host one", () => {
  const { isolationAvailability } = modules.actions;
  const t = i18n.t.bind(i18n);
  assert.deepEqual(isolationAvailability("checking", t), { disabled: true });
  assert.deepEqual(isolationAvailability("unknown", t), { disabled: false });
  assert.deepEqual(isolationAvailability({ available: true, uncommittedChanges: true }, t), { disabled: false });
  assert.deepEqual(
    isolationAvailability({ available: false, errorCode: "WORKTREE_DETACHED_HEAD", message: "raw" }, t),
    { disabled: true, reason: en.errors.detachedHead },
  );
  assert.deepEqual(
    isolationAvailability({ available: false, errorCode: "WORKTREE_INTERNAL", message: "git exploded" }, t),
    { disabled: true, reason: "git exploded" },
  );
});

test("creating an isolated session probes first and explains every refusal", async () => {
  const { createIsolatedSession } = modules.actions;
  const { useAppStore } = modules.store;
  const t = i18n.t.bind(i18n);
  const created = [];
  const toasts = [];
  useAppStore.setState({
    newSession: async (options) => {
      created.push(options);
    },
    showToast: (message, options) => toasts.push({ message, variant: options?.variant }),
  });

  stubBridge({
    [IPC.invoke.worktreeProbe]: () => ({ available: false, errorCode: "WORKTREE_NOT_GIT", message: "raw" }),
  });
  await createIsolatedSession("/plain", t);
  assert.deepEqual(created, []);
  assert.deepEqual(toasts, [{ message: en.errors.notGit, variant: "error" }]);

  toasts.length = 0;
  const calls = stubBridge({
    [IPC.invoke.worktreeProbe]: () => ({ available: true, uncommittedChanges: true }),
  });
  await createIsolatedSession("/repo", t);
  assert.deepEqual(calls[0].payload, { projectPath: "/repo" });
  assert.deepEqual(created, [{ projectPath: "/repo", isolated: true }]);
  assert.deepEqual(toasts, [{ message: en.uncommittedNotIncluded, variant: "info" }]);

  toasts.length = 0;
  useAppStore.setState({
    newSession: async () => {
      throw Object.assign(new Error("git 2.20 is older than the required 2.29"), {
        code: "WORKTREE_GIT_TOO_OLD",
      });
    },
  });
  stubBridge({
    [IPC.invoke.worktreeProbe]: () => ({ available: true, uncommittedChanges: false }),
  });
  await createIsolatedSession("/repo", t);
  assert.deepEqual(toasts, [{ message: en.errors.gitTooOld, variant: "error" }]);
});

test("merge failures keep conflicts in the session and re-preview a changed session", () => {
  const { mergeFailureState } = modules.actions;
  const t = i18n.t.bind(i18n);
  const conflict = Object.assign(new Error("merge conflict"), {
    code: "WORKTREE_CONFLICT",
    details: { errorCode: "WORKTREE_CONFLICT", files: ["src/a.ts", "README.md"] },
  });
  assert.deepEqual(mergeFailureState(conflict, t), {
    phase: "conflict",
    files: ["src/a.ts", "README.md"],
  });
  assert.deepEqual(mergeFailureState({ code: "WORKTREE_CHANGED_SINCE_PREVIEW" }, t), {
    phase: "reload",
    notice: en.errors.changedSincePreview,
  });
  assert.deepEqual(mergeFailureState({ code: "WORKTREE_PROJECT_DIRTY" }, t), {
    phase: "failed",
    message: en.errors.projectDirty,
  });
  assert.deepEqual(mergeFailureState(new Error("unexpected host failure"), t), {
    phase: "failed",
    message: "unexpected host failure",
  });
});

test("the delete loss note stays empty until unmerged work is known", () => {
  // Before the pending-work answer arrives only the ordinary armed label shows.
  assert.equal(wrap(createElement(DeleteLoss, { sessionId: "s1" })), "");
  assert.ok(en.deleteLoss.length > 0);
});

test("syncing from the project reports new commits, an up-to-date session, and conflicts", async () => {
  const { syncIsolatedSession } = modules.actions;
  const { useAppStore } = modules.store;
  const t = i18n.t.bind(i18n);
  const toasts = [];
  let refreshed = 0;
  useAppStore.setState({
    showToast: (message, options) => toasts.push({ message, variant: options?.variant }),
    refreshSessions: async () => {
      refreshed += 1;
    },
  });

  stubBridge({ [IPC.invoke.worktreeSync]: () => ({ result: "synced", commits: 3 }) });
  await syncIsolatedSession("s1", t);
  stubBridge({ [IPC.invoke.worktreeSync]: () => ({ result: "upToDate" }) });
  await syncIsolatedSession("s1", t);
  stubBridge({
    [IPC.invoke.worktreeSync]: () => {
      throw Object.assign(new Error("merge conflict"), {
        code: "WORKTREE_CONFLICT",
        details: { errorCode: "WORKTREE_CONFLICT", files: ["f.txt", "g.txt"] },
      });
    },
  });
  await syncIsolatedSession("s1", t);

  assert.deepEqual(toasts, [
    { message: i18n.t("worktree.sync.success", { count: 3 }), variant: "success" },
    { message: en.sync.upToDate, variant: "info" },
    { message: i18n.t("worktree.sync.conflict", { files: "f.txt, g.txt" }), variant: "error" },
  ]);
  // The badge follows: the list is refreshed after every attempt.
  assert.equal(refreshed, 3);
});

test("the behind marker shows only for sessions that lack project commits", () => {
  const { WorktreeBadge } = modules.parts;
  const { isolatedSessionsKey } = modules.behind;
  const { useWorktreeUi } = modules.worktreeUi;
  const active = { branch: "pi-desktop/a", status: "active", setupStatus: "none" };
  // Server rendering reads the store's initial state (as the sidebar test does).
  Object.assign(useWorktreeUi.getInitialState(), { behind: { s1: 3, s2: 0 } });

  const behind = wrap(createElement(WorktreeBadge, { worktree: active, sessionId: "s1" }));
  assert.match(behind, /data-worktree-behind="3"/);
  assert.ok(behind.includes(i18n.t("worktree.badge.behind", { count: 3 })));
  assert.ok(behind.includes(i18n.t("worktree.badge.behindTitle", { count: 3 }).replaceAll('"', "&quot;")));
  assert.doesNotMatch(wrap(createElement(WorktreeBadge, { worktree: active, sessionId: "s2" })), /data-worktree-behind/);
  assert.doesNotMatch(wrap(createElement(WorktreeBadge, { worktree: active })), /data-worktree-behind/);
  assert.doesNotMatch(
    wrap(createElement(WorktreeBadge, { worktree: { ...active, status: "missing" }, sessionId: "s1" })),
    /data-worktree-behind/,
  );

  // The counts are re-read when an isolated session appears, changes status,
  // or finishes a turn; ordinary sessions never trigger it.
  const at = "2020-01-01T00:00:00Z";
  const plain = { id: "p", updatedAt: at };
  const isolated = { id: "s1", updatedAt: at, worktree: active };
  const base = isolatedSessionsKey([plain, isolated]);
  assert.equal(isolatedSessionsKey([isolated]), base);
  assert.equal(isolatedSessionsKey([plain]), "");
  assert.notEqual(isolatedSessionsKey([{ ...isolated, updatedAt: "2020-01-02T00:00:00Z" }]), base);
  assert.notEqual(isolatedSessionsKey([{ ...isolated, worktree: { ...active, status: "merged" } }]), base);
  assert.equal(isolatedSessionsKey([{ ...isolated, worktree: { ...active, status: "missing" } }]), "");
});

test("a conflicted session hides the behind marker and cannot sync until it resolves", () => {
  const { WorktreeBadge } = modules.parts;
  const { useWorktreeUi } = modules.worktreeUi;
  Object.assign(useWorktreeUi.getInitialState(), { behind: { s1: 3 } });
  const conflicted = { branch: "pi-desktop/s1", status: "conflict", setupStatus: "none" };

  const badge = wrap(createElement(WorktreeBadge, { worktree: conflicted, sessionId: "s1" }));
  assert.match(badge, /data-worktree-status="conflict"/);
  assert.doesNotMatch(badge, /data-worktree-behind/);

  const menu = wrap(
    createElement(SessionItems, {
      sessionId: "s1",
      title: "Task",
      running: false,
      onDone() {},
      worktree: conflicted,
    }),
  );
  const sync = menu.slice(menu.indexOf('data-action="worktree-sync"') - 200, menu.indexOf("</button>", menu.indexOf('data-action="worktree-sync"')));
  assert.match(sync, /disabled=""/);
  assert.ok(sync.includes(en.sync.resolveFirst), sync);
  assert.doesNotMatch(sync, /aria-busy/);
  // Merging stays available: it concludes the resolution.
  assert.doesNotMatch(menu, /data-action="worktree-merge"[^>]*disabled/);
});

test("every actionable worktree error has a localized message in every locale", () => {
  const { worktreeErrorMessage } = modules.actions;
  const { WorktreeErrorCodes } = modules.shared;
  const t = i18n.t.bind(i18n);
  // Conflicts list their files and a changed session is previewed again.
  const handledElsewhere = new Set(["WORKTREE_CONFLICT"]);
  for (const code of Object.values(WorktreeErrorCodes)) {
    if (handledElsewhere.has(code)) continue;
    const message = worktreeErrorMessage(Object.assign(new Error("raw git output"), { code }), t);
    assert.notEqual(message, "raw git output", `${code} shows the raw host message`);
  }
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(
      Object.keys(catalog.worktree.errors).sort(),
      Object.keys(en.errors).sort(),
      `${locale} worktree errors`,
    );
    assert.match(catalog.worktree.sync.conflict, /\{\{files\}\}/, `${locale} sync conflict`);
  }
});
