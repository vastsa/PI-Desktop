import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

test("scheduled sidebar defaults off, preserves explicit choices, and rejects invalid writes", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "darwin" } };
  try {
    for (const stored of [undefined, false, true]) {
      const settings = renderer.normalizeSettings({ theme: "light", sidebarScheduledTasks: stored });
      assert.equal(settings.sidebarScheduledTasks, stored === true);
      const written = renderer.validateSettingsWrite({ ...settings, fontScale: 1 });
      const persisted = main.validateSettingsWrite(structuredClone(written));
      assert.equal(persisted.sidebarScheduledTasks, stored === true);
    }
    for (const value of ["yes", 1, null, undefined, {}]) {
      assert.throws(
        () => renderer.validateSettingsWrite({ sidebarScheduledTasks: value }),
        /sidebarScheduledTasks is invalid/,
      );
    }
  } finally {
    globalThis.window = previousWindow;
  }
});

test("scheduled folders remember folding independently by normalized project path", async () => {
  const { loadScheduledSidebarCollapsed, saveScheduledSidebarCollapsed, SIDEBAR_PREFERENCES_KEY } =
    await import("../src/lib/sidebar-preferences.ts");
  const previousStorage = globalThis.localStorage;
  const values = new Map([
    [SIDEBAR_PREFERENCES_KEY, '{"projectMeta":{"/scheduled":{"collapsed":true}}}'],
    ["pi.desktop.sidebarScheduledTasksCollapsed", "true"],
  ]);
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    assert.equal(loadScheduledSidebarCollapsed("/scheduled"), false);
    saveScheduledSidebarCollapsed("/scheduled/", true);
    assert.equal(loadScheduledSidebarCollapsed("/scheduled"), true);
    assert.equal(loadScheduledSidebarCollapsed("/other"), false);
    saveScheduledSidebarCollapsed("/other", true);
    saveScheduledSidebarCollapsed("/scheduled", false);
    assert.equal(loadScheduledSidebarCollapsed("/scheduled"), false);
    assert.equal(loadScheduledSidebarCollapsed("/other"), true);
    saveScheduledSidebarCollapsed("C:\\project\\", true);
    assert.equal(loadScheduledSidebarCollapsed("C:/project"), true);
    assert.equal(values.get(SIDEBAR_PREFERENCES_KEY), '{"projectMeta":{"/scheduled":{"collapsed":true}}}');
    globalThis.localStorage.getItem = () => { throw new Error("storage unavailable"); };
    assert.equal(loadScheduledSidebarCollapsed("/other"), false);
    globalThis.localStorage.setItem = () => { throw new Error("storage unavailable"); };
    assert.doesNotThrow(() => saveScheduledSidebarCollapsed("/other", true));
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test("task folders use explicit project paths, preserving duplicate task names", async () => {
  const { groupScheduledSidebarTasks } = await import("../src/features/scheduled/sidebar-scheduled-tasks.ts");
  const tasks = [
    { id: "a", title: "Review", workspacePath: "/work/project/" },
    { id: "b", title: "Review", workspacePath: "/work/project" },
    { id: "windows", title: "Review", workspacePath: "C:\\work\\project\\" },
    { id: "unbound", title: "Review" }, { id: "blank", workspacePath: "  " },
  ];
  const groups = groupScheduledSidebarTasks(tasks);
  assert.deepEqual([...groups.keys()], ["/work/project", "C:/work/project"]);
  assert.deepEqual(groups.get("/work/project").map((task) => task.id), ["a", "b"]);
  assert.deepEqual(groups.get("C:/work/project").map((task) => task.id), ["windows"]);
  assert.equal(tasks[0].workspacePath, "/work/project/");
});

test("folder and parent activity count only the latest run of their own tasks", async () => {
  const { scheduledSidebarRunSummary } = await import("../src/features/scheduled/sidebar-scheduled-tasks.ts");
  const { latestRunByTask } = await import("../src/features/scheduled/scheduled-runs.ts");
  const latest = latestRunByTask([
    { id: "old", taskId: "a", sessionId: "old-session", status: "running", startedAt: "2026-10-28T00:00:00Z" },
    { id: "new", taskId: "a", sessionId: "new-session", status: "completed", startedAt: "2026-10-29T00:00:00Z" },
    { id: "waiting", taskId: "b", sessionId: "waiting-session", status: "running", startedAt: "2026-10-29T00:00:00Z" },
    { id: "running", taskId: "c", sessionId: null, status: "running", startedAt: "2026-10-29T00:00:00Z" },
  ]);
  assert.deepEqual(scheduledSidebarRunSummary([{ id: "a" }, { id: "b" }, { id: "c" }], latest,
    { "waiting-session": [{}] }), { running: 1, waiting: 1, total: 3 });
  assert.deepEqual(scheduledSidebarRunSummary([{ id: "a" }], latest, {}), { running: 0, waiting: 0, total: 1 });
});
