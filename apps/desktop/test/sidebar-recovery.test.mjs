import assert from "node:assert/strict";
import test from "node:test";
import * as sidebar from "../src/lib/sidebar-preferences.ts";

const key = "pi.desktop.sidebarPreferences";
const preferences = (paths = ["/work/alpha", "/work/beta"]) => ({
  sessionMeta: { conversation: { pinned: true } },
  projectMeta: { "/work/alpha": { collapsed: true, order: 1 } },
  projectSort: "manual", sessionView: { sort: "recent", archived: false },
  openProjectPaths: paths,
});

function fixture(t, { local, backup = null, projects = [] } = {}) {
  const values = new Map(local === undefined ? [] : [[key, JSON.stringify(local)]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const writes = [];
  const port = { read: async () => backup, write: async value => { writes.push(value); },
    listProjects: async () => ({ projects: projects.map(path => ({ path })) }) };
  return { values, writes, port };
}

test("a fresh Chromium profile restores retained projects and organization from the application backup", async t => {
  const backup = preferences();
  const h = fixture(t, { backup });
  const restored = await sidebar.restoreSidebarPreferences(h.port);
  assert.deepEqual(restored, backup);
  assert.deepEqual(sidebar.loadSidebarPreferences(), backup);
});

test("a malformed renderer cache recovers from the application backup", async t => {
  const backup = preferences();
  const h = fixture(t, { backup });
  h.values.set(key, "{broken");
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), backup);
});

test("valid legacy preferences migrate without reopening intentionally closed project tabs", async t => {
  const local = preferences([]);
  const h = fixture(t, { local, projects: ["/historical"] });
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), local);
  assert.deepEqual(h.writes.at(-1), local);
});

test("an existing application backup wins over an incomplete renderer snapshot", async t => {
  const backup = preferences();
  const h = fixture(t, { backup, local: preferences(["/default"]) });
  assert.deepEqual(await sidebar.restoreSidebarPreferences(h.port), backup);
});

test("an explicitly empty backup stays empty with a fresh Chromium profile", async t => {
  const h = fixture(t, { backup: preferences([]) });
  h.port.listProjects = async () => { throw new Error("Closed tabs must not query the catalog"); };
  assert.deepEqual((await sidebar.restoreSidebarPreferences(h.port)).openProjectPaths, []);
});

test("legacy cache loss recovers known projects once and persists subsequent explicit closes", async t => {
  const h = fixture(t, { projects: ["/default", "/work/alpha", "/work/beta"] });
  const recovered = await sidebar.restoreSidebarPreferences(h.port);
  assert.deepEqual(recovered.openProjectPaths, ["/default", "/work/alpha", "/work/beta"]);
  sidebar.saveSidebarPreferences({ ...recovered, openProjectPaths: ["/default"] });
  await Promise.resolve();
  h.port.read = async () => h.writes.at(-1);
  assert.deepEqual((await sidebar.restoreSidebarPreferences(h.port)).openProjectPaths, ["/default"]);
});

test("a failed backup read cannot overwrite a potentially valid backup with empty startup state", async t => {
  const h = fixture(t);
  h.port.read = async () => { throw new Error("Disk unavailable"); };
  assert.equal(await sidebar.restoreSidebarPreferences(h.port), null);
  sidebar.saveSidebarPreferences(preferences(["/default"]));
  await Promise.resolve();
  assert.deepEqual(h.writes, []);
});

test("a project catalog failure does not persist an empty recovery result", async t => {
  const h = fixture(t);
  h.port.listProjects = async () => { throw new Error("Host unavailable"); };
  await assert.rejects(sidebar.restoreSidebarPreferences(h.port), /Host unavailable/);
  assert.deepEqual(h.writes, []);
});

test("a user layout change during backup read supersedes the older response", async t => {
  const h = fixture(t, { local: preferences() });
  let resolve;
  h.port.read = () => new Promise(yes => { resolve = yes; });
  const pending = sidebar.restoreSidebarPreferences(h.port);
  const newer = preferences(["/newly-opened"]);
  sidebar.saveSidebarPreferences(newer);
  resolve(preferences(["/old"]));
  assert.deepEqual(await pending, newer);
  assert.deepEqual(h.writes.at(-1), newer);
});
