import assert from "node:assert/strict";
import test from "node:test";
import { loadProjectPicker } from "./helpers/plugin-projects.mjs";

const { createPluginProjectLister } = await import("../electron/main/services/plugin-projects.ts");

test("a projectless session can browse projects from the plugin command and panel bridge", async (t) => {
  const projects = [{ projectId: "42", name: "Solo", primaryPath: "/solo",
    roots: [{ path: "/solo", name: "Solo", primary: true }] }];
  const runtime = await loadProjectPicker(t, { listProjects: async () => projects });
  await runtime.getCommands().find((command) => command.id === "pick-project").run();
  assert.deepEqual(JSON.parse(runtime.drainToasts()[0]), { projects, workspace: null });
  assert.deepEqual(await runtime.invokePanelBridge("demo.projects", "projects.list", {}), projects);
});

test("a host without a projects provider returns an empty list", async (t) => {
  const runtime = await loadProjectPicker(t);
  await runtime.getCommands().find((command) => command.id === "pick-project").run();
  assert.deepEqual(JSON.parse(runtime.drainToasts()[0]), { projects: [], workspace: null });
  assert.deepEqual(await runtime.invokePanelBridge("demo.projects", "projects.list", {}), []);
});

const solo = { id: 7, path: "/solo", name: "Solo", pinned: true, lastOpenedAt: 10, createdAt: 1 };
const multi = { id: 8, path: "/multi", name: "Multi", pinned: false, lastOpenedAt: 20, createdAt: 1 };
const secondary = { id: 9, path: "/other", name: "Other", pinned: false, lastOpenedAt: 15, createdAt: 1 };
const group = { id: "group-id", name: "Multi", primaryPath: "/multi", roots: [
  { path: "/other", name: "other", position: 1 },
  { path: "/multi", name: "multi", position: 0 },
] };

function fixture(projects = [solo, multi, secondary], groups = [group]) {
  return { isAvailable: () => true, call: async (method) => {
    if (method === "projects.list") return { projects };
    assert.equal(method, "project.groups.list");
    return { groups };
  }};
}

test("durable rows retain individual identities and roots, sorted by recency regardless of pins", async () => {
  const host = fixture();
  const list = createPluginProjectLister(() => host, assert.fail);
  const projects = await list();
  assert.deepEqual(projects, [
    { projectId: "8", name: "Multi", primaryPath: "/multi", roots: [
      { path: "/multi", name: "multi", primary: true },
      { path: "/other", name: "other", primary: false },
    ] },
    { projectId: "9", name: "Other", primaryPath: "/other", roots: [
      { path: "/other", name: "Other", primary: true },
    ] },
    { projectId: "7", name: "Solo", primaryPath: "/solo", roots: [
      { path: "/solo", name: "Solo", primary: true },
    ] },
  ]);
  solo.name = "Renamed";
  assert.equal((await list()).find((project) => project.primaryPath === "/solo").projectId, "7");
  solo.name = "Solo";
});

test("missing or failing group metadata preserves every project with its own primary root", async () => {
  for (const groupsResult of [null, {}, new Error("groups unavailable")]) {
    const failures = [];
    const host = fixture();
    const call = host.call;
    host.call = async (method) => {
      if (method === "projects.list") return call(method);
      if (groupsResult instanceof Error) throw groupsResult;
      return groupsResult;
    };
    const projects = await createPluginProjectLister(() => host, (op) => failures.push(op))();
    assert.equal(projects.length, 3);
    assert.ok(projects.every((project) => project.roots.length === 1 && project.roots[0].primary));
    assert.deepEqual(failures, ["project.groups.list"]);
  }
});

test("unavailable, empty, malformed and failed project hosts resolve to empty lists", async () => {
  const failures = [];
  for (const host of [null, { isAvailable: () => false }, fixture([]), fixture(null),
    { isAvailable: () => true, call: async () => { throw new Error("host stopped"); } }]) {
    assert.deepEqual(await createPluginProjectLister(() => host, (op) => failures.push(op))(), []);
  }
  assert.deepEqual(failures, ["projects.list", "projects.list"]);
});

test("host replacement while listing discards the old host's response", async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let host = fixture();
  const call = host.call;
  host.call = async (method) => {
    if (method === "projects.list") {
      started.resolve();
      await finish.promise;
    }
    return call(method);
  };
  const pending = createPluginProjectLister(() => host, assert.fail)();
  await started.promise;
  host = fixture([]);
  finish.resolve();
  assert.deepEqual(await pending, []);
});

test("remote projects expose only opaque identities and registered roots", async () => {
  const path = "remote-project:remote-group";
  const host = fixture([{ ...solo, id: 11, path, name: "Remote row" }], [{
    id: "remote-group", name: "Remote display name", primaryPath: path,
    roots: [{ path, name: "Remote root", position: 0 }],
    remote: { hostKey: "private-host-key", path: "/home/private/repo" },
  }]);
  assert.deepEqual(await createPluginProjectLister(() => host, assert.fail)(), [{
    projectId: "11", name: "Remote display name", primaryPath: path,
    roots: [{ path, name: "Remote root", primary: true }],
  }]);
});

test("equal last-opened timestamps use numeric ids without mutating host order", async () => {
  const rows = [{ ...solo, id: 12 }, { ...solo, id: 2 }];
  const host = fixture(rows, []);
  const projects = await createPluginProjectLister(() => host, assert.fail)();
  assert.deepEqual(projects.map((project) => project.projectId), ["2", "12"]);
  assert.deepEqual(rows.map((project) => project.id), [12, 2]);
});
