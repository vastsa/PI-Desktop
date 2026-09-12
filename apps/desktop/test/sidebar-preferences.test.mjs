import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSidebarWidth,
  loadSidebarPreferences,
  loadSidebarWidth,
  projectIsArchived,
  projectIsCollapsed,
  projectIsPinned,
  normalizeProjectName,
  saveSidebarPreferences,
  saveSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  sortProjects,
  sortSessions,
  filterSwitcherProjects,
  listSwitcherProjects,
} from "../src/lib/sidebar-preferences.ts";
import { loadRecentProjects, renameRecentProject } from "../src/lib/recent-projects.ts";

function session(overrides = {}) {
  return {
    id: "session",
    title: "Session",
    mode: "agent",
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T11:00:00.000Z",
    ...overrides,
  };
}

test("pinned sessions sort before the selected secondary order", () => {
  const rows = sortSessions(
    [
      session({ id: "newer", title: "Zeta", updatedAt: "2026-07-26T10:00:00.000Z" }),
      session({ id: "pinned", title: "Alpha", updatedAt: "2026-07-20T10:00:00.000Z" }),
      session({ id: "archived", title: "Archived" }),
    ],
    {
      pinned: { pinned: true },
      archived: { archived: true },
    },
    "recent",
  );

  assert.deepEqual(rows.map((row) => row.id), ["pinned", "newer"]);
  assert.deepEqual(
    sortSessions(
      [session({ id: "active" }), session({ id: "archived" })],
      { archived: { archived: true } },
      "recent",
      true,
    ).map((row) => row.id),
    ["active", "archived"],
  );
});

test("keeps archived sessions after active sessions when archive visibility is enabled", () => {
  const rows = sortSessions(
    [
      session({ id: "archived", updatedAt: "2026-07-26T12:00:00.000Z" }),
      session({ id: "active", updatedAt: "2026-07-25T12:00:00.000Z" }),
    ],
    { archived: { archived: true } },
    "recent",
    true,
  );

  assert.deepEqual(rows.map((row) => row.id), ["active", "archived"]);
});

test("project metadata uses normalized paths", () => {
  const meta = {
    "/work/app": { pinned: true, archived: true, collapsed: true },
  };

  assert.equal(projectIsPinned("/work/app/", meta), true);
  assert.equal(projectIsArchived("/work/app/", meta), true);
  assert.equal(projectIsCollapsed("/work/app/", meta), true);
});

test("project display names are trimmed, persisted, and bounded by Unicode characters", () => {
  assert.equal(normalizeProjectName("  API workspace  "), "API workspace");
  assert.equal(normalizeProjectName("界".repeat(80)), "界".repeat(80));
  assert.equal(normalizeProjectName("界".repeat(81)), undefined);
  assert.equal(normalizeProjectName("   "), undefined);

  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key() {
      return null;
    },
    get length() {
      return values.size;
    },
  };

  try {
    saveSidebarPreferences({
      sessionMeta: {},
      projectMeta: {
        "/work/api/": { name: "  API workspace  ", pinned: true },
        "/work/invalid": { name: "界".repeat(81), archived: true },
      },
      projectSort: "recent",
      sessionView: { sort: "recent", archived: false },
      openProjectPaths: [],
    });
    const loaded = loadSidebarPreferences();
    assert.deepEqual(loaded.projectMeta["/work/api"], {
      name: "API workspace",
      pinned: true,
    });
    assert.deepEqual(loaded.projectMeta["/work/invalid"], { archived: true });
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("projects sort by name while retaining pinned priority", () => {
  const projects = sortProjects(
    [
      { path: "/work/zeta", name: "Zeta" },
      { path: "/work/alpha", name: "Alpha" },
      { path: "/work/beta", name: "Beta" },
    ],
    { "/work/beta": { pinned: true } },
    "name",
  );

  assert.deepEqual(
    projects.map((project) => project.name),
    ["Beta", "Alpha", "Zeta"],
  );
});

test("manual project order follows persisted metadata while retaining pinned priority", () => {
  const projects = sortProjects(
    [
      { path: "/work/third", name: "Third" },
      { path: "/work/first", name: "First" },
      { path: "/work/pinned", name: "Pinned" },
      { path: "/work/unordered", name: "Unordered" },
    ],
    {
      "/work/third": { order: 2 },
      "/work/first": { order: 0 },
      "/work/pinned": { pinned: true, order: 1 },
    },
    "manual",
  );

  assert.deepEqual(
    projects.map((project) => project.name),
    ["Pinned", "First", "Third", "Unordered"],
  );
});

test("manual project order ignores negative and fractional persisted ranks", () => {
  const projects = [
    { path: "/work/invalid", name: "Invalid" },
    { path: "/work/fractional", name: "Fractional" },
    { path: "/work/valid", name: "Valid" },
  ];
  const sorted = sortProjects(
    projects,
    {
      "/work/invalid": { order: -1 },
      "/work/fractional": { order: 1.5 },
      "/work/valid": { order: 0 },
    },
    "manual",
  );
  assert.deepEqual(sorted.map((project) => project.path), [
    "/work/valid",
    "/work/fractional",
    "/work/invalid",
  ]);
});

test("all user-facing session sort modes produce stable secondary order", () => {
  const sessions = [
    session({
      id: "beta",
      title: "Beta",
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-26T10:00:00.000Z",
    }),
    session({
      id: "alpha",
      title: "Alpha",
      createdAt: "2026-07-26T10:00:00.000Z",
      updatedAt: "2026-07-25T10:00:00.000Z",
    }),
  ];

  assert.deepEqual(
    sortSessions(sessions, {}, "recent").map((row) => row.id),
    ["beta", "alpha"],
  );
  assert.deepEqual(
    sortSessions(sessions, {}, "created").map((row) => row.id),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    sortSessions(sessions, {}, "oldest").map((row) => row.id),
    ["beta", "alpha"],
  );
  assert.deepEqual(
    sortSessions(sessions, {}, "name").map((row) => row.id),
    ["alpha", "beta"],
  );
});

test("project time sort modes keep missing timestamps stable at the end", () => {
  const projects = [
    { path: "/work/missing", name: "Missing" },
    { path: "/work/new", name: "New", openedAt: 30, createdAt: 20 },
    { path: "/work/old", name: "Old", openedAt: 10, createdAt: 5 },
  ];

  assert.deepEqual(
    sortProjects(projects, {}, "recent").map((project) => project.name),
    ["New", "Old", "Missing"],
  );
  assert.deepEqual(
    sortProjects(projects, {}, "created").map((project) => project.name),
    ["New", "Old", "Missing"],
  );
  assert.deepEqual(
    sortProjects(projects, {}, "oldest").map((project) => project.name),
    ["Old", "New", "Missing"],
  );
});

test("session time sort modes keep missing timestamps stable at the end", () => {
  const sessions = [
    session({ id: "missing", createdAt: undefined, updatedAt: undefined }),
    session({
      id: "new",
      createdAt: "2026-07-26T10:00:00.000Z",
      updatedAt: "2026-07-26T11:00:00.000Z",
    }),
    session({
      id: "old",
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T11:00:00.000Z",
    }),
  ];

  assert.deepEqual(
    sortSessions(sessions, {}, "recent").map((row) => row.id),
    ["new", "old", "missing"],
  );
  assert.deepEqual(
    sortSessions(sessions, {}, "created").map((row) => row.id),
    ["new", "old", "missing"],
  );
  assert.deepEqual(
    sortSessions(sessions, {}, "oldest").map((row) => row.id),
    ["old", "new", "missing"],
  );
});

test("legacy pin preferences migrate once and respect a later unpin", () => {
  const values = new Map([
    ["pi.desktop.pinnedSessions", JSON.stringify(["legacy-session"])],
    ["pi.desktop.pinnedProjects", JSON.stringify(["/work/legacy/"])],
  ]);
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key() {
      return null;
    },
    get length() {
      return values.size;
    },
  };

  try {
    const migrated = loadSidebarPreferences();
    assert.equal(migrated.sessionMeta["legacy-session"].pinned, true);
    assert.equal(migrated.projectMeta["/work/legacy"].pinned, true);

    saveSidebarPreferences({
      ...migrated,
      sessionMeta: {
        ...migrated.sessionMeta,
        "legacy-session": { pinned: false },
      },
      projectMeta: {
        ...migrated.projectMeta,
        "/work/legacy": { pinned: false },
      },
    });

    const reloaded = loadSidebarPreferences();
    assert.equal(reloaded.sessionMeta["legacy-session"].pinned, false);
    assert.equal(reloaded.projectMeta["/work/legacy"].pinned, false);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("persists retained project paths and per-project collapse state", () => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key() {
      return null;
    },
    get length() {
      return values.size;
    },
  };

  try {
    saveSidebarPreferences({
      sessionMeta: {},
      projectMeta: {
        "/work/a": { collapsed: true, order: 2 },
        "/work/b": { pinned: true, order: 1 },
      },
      projectSort: "name",
      sessionView: { sort: "created", archived: true },
      openProjectPaths: ["/work/a/", "/work/b", "/work/a"],
    });

    const loaded = loadSidebarPreferences();
    assert.deepEqual(loaded.openProjectPaths, ["/work/a/", "/work/b"]);
    assert.equal(projectIsCollapsed("/work/a", loaded.projectMeta), true);
    assert.equal(loaded.projectMeta["/work/a"].order, 2);
    assert.equal(loaded.projectMeta["/work/b"].order, 1);
    assert.equal(loaded.projectSort, "name");
    assert.equal(loaded.sessionView.sort, "created");
    assert.equal(loaded.sessionView.archived, true);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("clamps and persists the expanded sidebar width", () => {
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 1), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(312.4), 312);
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 1), SIDEBAR_WIDTH_MAX);

  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key() {
      return null;
    },
    get length() {
      return values.size;
    },
  };

  try {
    assert.equal(loadSidebarWidth(), SIDEBAR_WIDTH_DEFAULT);
    saveSidebarWidth(SIDEBAR_WIDTH_MAX + 100);
    assert.equal(loadSidebarWidth(), SIDEBAR_WIDTH_MAX);
    saveSidebarWidth(SIDEBAR_WIDTH_MIN - 100);
    assert.equal(loadSidebarWidth(), SIDEBAR_WIDTH_MIN);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("manual title metadata survives a renderer restart", () => {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  try {
    saveSidebarPreferences({
      sessionMeta: { custom: { manualTitle: true } },
      projectMeta: {},
      projectSort: "recent",
      sessionView: { sort: "recent", archived: false },
      openProjectPaths: [],
    });
    assert.equal(loadSidebarPreferences().sessionMeta.custom.manualTitle, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("renames a recent project without changing its recency", () => {
  const values = new Map([
    [
      "pi.desktop.recentProjects",
      JSON.stringify([
        { path: "/work/api/", name: "api", openedAt: 42, pinned: true },
        { path: "/work/web", name: "web", openedAt: 7 },
      ]),
    ],
  ]);
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key() {
      return null;
    },
    get length() {
      return values.size;
    },
  };

  try {
    renameRecentProject("/work/api", "API workspace");
    const renamed = loadRecentProjects();
    assert.equal(renamed[0].name, "API workspace");
    assert.equal(renamed[0].openedAt, 42);
    assert.equal(renamed[0].pinned, true);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("home switcher lists retained sidebar projects and the active workspace", () => {
  const projects = listSwitcherProjects({
    openProjectPaths: ["/Users/lan/PI-Desktop", "/Users/lan/pi-desktop-plugins"],
    openProjects: [
      { path: "/Users/lan/PI-Desktop", name: "PI-Desktop" },
      { path: "/Users/lan/pi-desktop-plugins", name: "pi-desktop-plugins" },
    ],
    workspace: { path: "/Users/lan/other", name: "other" },
    projectMeta: {},
    projectSort: "name",
  });

  assert.deepEqual(
    projects.map((project) => project.name),
    ["other", "PI-Desktop", "pi-desktop-plugins"],
  );
});

test("home switcher hides archived projects and prefers renamed labels", () => {
  const projects = listSwitcherProjects({
    openProjectPaths: ["/tmp/alpha", "/tmp/beta"],
    openProjects: [
      { path: "/tmp/alpha", name: "alpha" },
      { path: "/tmp/beta", name: "beta" },
    ],
    workspace: { path: "/tmp/alpha", name: "alpha" },
    projectMeta: {
      "/tmp/alpha": { name: "Alpha App" },
      "/tmp/beta": { archived: true },
    },
    projectSort: "name",
  });

  assert.deepEqual(
    projects.map((project) => ({ name: project.name, path: project.path })),
    [{ name: "Alpha App", path: "/tmp/alpha" }],
  );
});

test("home switcher search matches name or path and ignores case", () => {
  const projects = [
    { key: "/tmp/pi-desktop", path: "/tmp/pi-desktop", name: "PI-Desktop", pinned: false },
    {
      key: "/tmp/plugins",
      path: "/tmp/plugins",
      name: "pi-desktop-plugins",
      pinned: false,
    },
  ];

  assert.deepEqual(
    filterSwitcherProjects(projects, "PLUGIN").map((project) => project.name),
    ["pi-desktop-plugins"],
  );
  assert.deepEqual(
    filterSwitcherProjects(projects, "/tmp/pi-desktop").map((project) => project.name),
    ["PI-Desktop"],
  );
  assert.equal(filterSwitcherProjects(projects, "   ").length, 2);
});

test("home switcher collapses aliased paths and follows retained-tab recency", () => {
  const projects = listSwitcherProjects({
    openProjectPaths: ["/tmp/older", "/tmp/alpha/"],
    openProjects: [
      { path: "/tmp/older", name: "older" },
      { path: "/tmp/alpha", name: "alpha" },
    ],
    workspace: { path: "/tmp/alpha" },
    projectMeta: {},
    projectSort: "recent",
  });

  assert.deepEqual(
    projects.map((project) => project.name),
    ["alpha", "older"],
  );
  assert.equal(projects.length, 2);
});
