import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSidebarWidth,
  loadSidebarPreferences,
  loadSidebarWidth,
  projectIsArchived,
  projectIsCollapsed,
  projectIsPinned,
  saveSidebarPreferences,
  saveSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  sortProjects,
  sortSessions,
} from "../src/lib/sidebar-preferences.ts";

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
