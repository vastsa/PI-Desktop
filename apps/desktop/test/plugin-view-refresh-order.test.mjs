import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createCatalogSlice } = await import("../src/stores/slices/catalog-slice.ts");
const { createCatalogRuntime } = await import("../src/stores/runtime/catalog-runtime.ts");
const { api } = await import("../src/lib/api.ts");

test("a stale project view response cannot replace the current project's view catalog", async t => {
  let state = { activeProjectPath: "/first", pluginViews: [] };
  const slice = createCatalogSlice({ catalogRuntime: createCatalogRuntime(), get: () => state, set: patch => { state = { ...state, ...patch }; } });
  const releases = [];
  t.mock.method(api, "listPluginViews", () => new Promise(resolve => releases.push(resolve)));
  const first = slice.refreshPluginViews();
  state.activeProjectPath = "/second";
  const second = slice.refreshPluginViews();
  const secondViews = [{ pluginId: "second", id: "view" }];
  releases[1](secondViews); await second;
  releases[0]([{ pluginId: "first", id: "view" }]); await first;
  assert.deepEqual(state.pluginViews, secondViews);
});

test("a project change without a replacement request cannot apply old views", async t => {
  const current = [{ pluginId: "known", id: "view" }];
  let state = { activeProjectPath: "/first", pluginViews: current };
  const slice = createCatalogSlice({ get: () => state, set: patch => { state = { ...state, ...patch }; } });
  let release;
  t.mock.method(api, "listPluginViews", () => new Promise(resolve => { release = resolve; }));
  const reading = slice.refreshPluginViews();
  state.activeProjectPath = "/second";
  release([{ pluginId: "first", id: "view" }]); await reading;
  assert.equal(state.pluginViews, current);
});

test("stale errors cannot clear a successful newer view refresh", async t => {
  let state = { activeProjectPath: "/project", pluginViews: [] };
  const slice = createCatalogSlice({ get: () => state, set: patch => { state = { ...state, ...patch }; } });
  let reject;
  t.mock.method(api, "listPluginViews", () => new Promise((_, fail) => { reject = fail; }));
  const old = slice.refreshPluginViews();
  const current = [{ pluginId: "new", id: "view" }];
  t.mock.method(api, "listPluginViews", async () => current);
  await slice.refreshPluginViews();
  reject(new Error("old failure")); await old;
  assert.deepEqual(state.pluginViews, current);
});
