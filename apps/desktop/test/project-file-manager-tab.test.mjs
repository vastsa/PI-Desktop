import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import * as tabs from "../src/lib/work-panel-tabs.ts";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createWorkPanelSlice, switchWorkPanelSession } = await import("../src/stores/slices/work-panel-slice.ts");
const { createCatalogSlice } = await import("../src/stores/slices/catalog-slice.ts");
const { api } = await import("../src/lib/api.ts");
const view = tabs.FILE_MANAGER_PLUGIN_TAB;
const manager = tabs.pluginWorkPanelTab(view.pluginId, view.viewId);
const session = (id, projectPath, source) => ({ id, projectPath, source });
function setup() {
  let state = { activeSessionId: "B", workPanelOpen: false, activeWorkPanelTabId: null,
    workPanelTabs: [], workPanelContexts: {}, workPanelFileRequest: null, pluginViews: [view],
    fileManagerProjects: new Set(), fileManagerTabReceipts: {},
    sessions: [session("A", "/project"), session("B", "/project/"), session("D", "/other"), session("T"), session("R", "/project", "remote")],
  };
  const get = () => state;
  const set = (value) => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
  Object.assign(state, createWorkPanelSlice({ get, set, isSessionSelectionPending: () => false }));
  const select = (id, created) => set({ ...switchWorkPanelSession(state, id, created), activeSessionId: id,
    ...(created ? { sessions: [...state.sessions, created] } : {}) });
  return { get, set, select };
}

test("a project gets a plain File Manager entry once per session, not a shared dock or file location", () => {
  const { get, select } = setup();
  get().openWorkPanelTab(tabs.toolWorkPanelTab("review"));
  get().collapseWorkPanel();
  select("A");
  get().openNewWorkPanelTab();
  get().replaceWorkPanelTab(get().activeWorkPanelTabId, tabs.fileManagerPluginTab("private-in-A.txt"));
  select("B");
  assert.deepEqual(get().workPanelTabs, [tabs.toolWorkPanelTab("review"), manager]);
  assert.equal(get().workPanelOpen, false);
  assert.equal(get().activeWorkPanelTabId, "review");
  get().openWorkPanel();
  get().activateWorkPanelTab(manager.id);
  select("A");
  get().closeAllWorkPanelTabs();
  select("B");
  assert.equal(get().activeWorkPanelTabId, manager.id);
  assert.equal(get().workPanelOpen, true);
  get().closeOtherWorkPanelTabs("review");
  select("A");
  assert.deepEqual(get().workPanelTabs, []);
  select("C", session("C", "/project"));
  assert.deepEqual(get().workPanelTabs, [manager]);
  assert.equal(get().workPanelOpen, false);
  for (const id of ["D", "T", "R", "A"]) {
    select(id);
    assert.deepEqual(get().workPanelTabs, []);
  }
  get().openWorkPanelTab(manager);
  get().openWorkPanelTab(manager);
  assert.deepEqual(get().workPanelTabs, [manager]);
  select("B");
  assert.deepEqual(get().workPanelTabs, [tabs.toolWorkPanelTab("review")]);
});

test("a direct file reveal enables the default, but a late catalog seeds only when the view is available", async (t) => {
  const { get, set, select } = setup();
  get().openWorkPanelTab(tabs.fileManagerPluginTab("README.md"));
  set({ pluginViews: [] });
  select("A");
  assert.deepEqual(get().workPanelTabs, []);
  t.mock.method(api, "listPluginViews", async () => [view]);
  await createCatalogSlice({ get, set }).refreshPluginViews();
  assert.deepEqual(get().workPanelTabs, [manager]);
  get().closeWorkPanelTab(manager.id);
  select("B"); select("A");
  assert.deepEqual(get().workPanelTabs, []);
});
