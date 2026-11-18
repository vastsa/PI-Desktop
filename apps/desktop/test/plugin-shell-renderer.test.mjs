import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as resize from "../src/lib/work-panel-resize.ts";
import * as tabs from "../src/lib/work-panel-tabs.ts";
register(new URL("helpers/ts-import-hooks.mjs", import.meta.url));
const model = await import("../src/features/app/plugin-shell-layout-model.ts");
const { outputText } = ts.transpileModule(readFileSync(new URL("../src/stores/slices/work-panel-slice.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const imported = {
  "../../lib/api": { api: { pluginViewClose: async () => ({ ok: true }) } },
  "../../lib/remote-session-safety": { isRemoteSession: (session) => session?.source === "remote" },
  "../../lib/work-panel-tabs": tabs,
  "../../lib/work-panel-resize": resize,
};
const sliceModule = { exports: {} };
new Function("require", "exports", "module", outputText)((name) => {
  assert.ok(Object.hasOwn(imported, name), `unexpected module: ${name}`);
  return imported[name];
}, sliceModule.exports, sliceModule);

function fixture(overrides = {}) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  let state = {
    activeSessionId: "s1", selectingSessionId: undefined, sessions: [], pluginViews: [],
    workPanelOpen: false, workPanelTabs: [], activeWorkPanelTabId: null,
    workPanelContexts: {}, workPanelFileRequest: null, workPanelWidth: 360, workPanelYieldedWidth: null,
    ...overrides,
  };
  let shell = {
    ready: true, contextId: "ctx1", page: "chat", containerWidth: 1400,
    sidebarCollapsed: false, sidebarWidth: 280, sidebarPreferredWidth: 280,
    sidebarEntering: false, sidebarExiting: false, sidebarResizing: false,
    presentedWorkPanelOpen: state.workPanelOpen, workPanelExiting: false,
    workPanelMaximized: false, panelGeometry: null,
  };
  const get = () => state;
  const set = (value) => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
  state = { ...state, ...sliceModule.exports.createWorkPanelSlice({ get, set, isSessionSelectionPending: () => false }) };
  const dependencies = {
    getStore: get, getShell: () => shell,
    t: (key) => ({ "panel.new.title": "New tab", "panel.tabs.review": "Review", "panel.tabs.subagent": "Subagent" })[key] ?? key,
    commitSidebarWidth: (width) => { shell = { ...shell, sidebarWidth: width, sidebarPreferredWidth: width }; },
    toggleSidebar: () => {
      const collapsed = !shell.sidebarCollapsed;
      if (!collapsed && state.workPanelOpen) {
        state.setWorkPanelYieldedWidth(resize.workPanelWidthForSidebarReopen({ containerWidth: shell.containerWidth, sidebarWidth: shell.sidebarPreferredWidth, currentPanelWidth: state.workPanelWidth }));
      }
      shell = { ...shell, sidebarCollapsed: collapsed, sidebarWidth: shell.sidebarPreferredWidth };
    },
    autoCollapseSidebar: () => { shell = { ...shell, sidebarCollapsed: true }; },
  };
  return {
    get, set, read: () => model.readPluginShellLayout(dependencies),
    apply: (command, contextId = "ctx1") => model.applyPluginShellLayoutCommand(dependencies, command, contextId),
    shell: () => shell,
    updateShell: (next) => { shell = { ...shell, ...next }; },
  };
}

test("layout reads retain closed tabs and never change the real work-panel store", () => {
  assert.equal(typeof model.readPluginShellLayout, "function");
  const f = fixture();
  f.get().openWorkPanelTab(tabs.fileWorkPanelTab("/work/example.ts"));
  f.get().collapseWorkPanel();
  const before = f.get();
  const snapshot = f.read();
  assert.equal(snapshot.layout.workPanel.visible, false);
  assert.equal(snapshot.layout.workPanel.width, 360);
  assert.deepEqual(snapshot.layout.workPanel.tabs, [{ id: "file:/work/example.ts", kind: "file", label: "example.ts", resource: "/work/example.ts" }]);
  assert.equal(f.get(), before);
});

test("existing and unknown tab activation never opens a collapsed panel", () => {
  const f = fixture();
  f.get().openWorkPanelTab(tabs.fileWorkPanelTab("/work/a.ts"));
  f.get().openWorkPanelTab(tabs.fileWorkPanelTab("/work/b.ts"));
  f.get().collapseWorkPanel();
  assert.equal(f.apply({ kind: "activateTab", tabId: "file:/work/a.ts" }), true);
  assert.equal(f.get().activeWorkPanelTabId, "file:/work/a.ts");
  assert.equal(f.get().workPanelOpen, false);
  assert.equal(f.apply({ kind: "activateTab", tabId: "closed-tab" }), false);
  assert.equal(f.apply({ kind: "activateTab", tabId: "" }), false);
  assert.equal(f.get().activeWorkPanelTabId, "file:/work/a.ts");
});

test("show/hide preserves existing context and opening an empty panel creates no tab", () => {
  const f = fixture();
  f.apply({ kind: "setWorkPanel", input: { visible: true } });
  assert.equal(f.get().workPanelOpen, true);
  assert.deepEqual(f.get().workPanelTabs, []);
  assert.equal(f.apply({ kind: "setWorkPanel", input: { visible: true } }), false);
  f.get().openWorkPanelTab(tabs.toolWorkPanelTab("review"));
  const active = f.get().activeWorkPanelTabId;
  f.apply({ kind: "setWorkPanel", input: { visible: false } });
  f.apply({ kind: "setWorkPanel", input: { visible: true } });
  assert.equal(f.get().activeWorkPanelTabId, active);
  assert.equal(f.get().workPanelTabs.length, 1);
});

test("sidebar setters clamp, reopen at the requested preference and are idempotent", () => {
  const f = fixture();
  f.apply({ kind: "setSidebar", input: { collapsed: true, width: 100 } });
  assert.equal(f.read().layout.sidebar.width, 240);
  f.apply({ kind: "setSidebar", input: { collapsed: false, width: 100 } });
  assert.equal(f.shell().sidebarWidth, 240);
  assert.equal(f.shell().sidebarCollapsed, false);
  assert.equal(f.apply({ kind: "setSidebar", input: { collapsed: false, width: 100 } }), false);
  f.apply({ kind: "setSidebar", input: { width: 10000 } });
  assert.equal(f.shell().sidebarWidth, 520);
});

test("work-panel widths use the live budget without a fixed cap or repeated growth", () => {
  const f = fixture({ workPanelOpen: true });
  f.apply({ kind: "setWorkPanel", input: { width: 10000 } });
  assert.equal(f.shell().sidebarCollapsed, true);
  assert.equal(f.get().workPanelWidth, 950);
  assert.equal(f.apply({ kind: "setWorkPanel", input: { width: 10000 } }), false);
  f.updateShell({ containerWidth: 3000 });
  f.apply({ kind: "setWorkPanel", input: { width: 2000 } });
  assert.equal(f.get().workPanelWidth, 2000);
  f.apply({ kind: "setWorkPanel", input: { width: 100 } });
  assert.equal(f.get().workPanelWidth, 244);
});

test("live geometry includes compact width loans and uncommitted drag previews", () => {
  const f = fixture({ workPanelOpen: true, workPanelYieldedWidth: 131 });
  f.updateShell({ containerWidth: 871, panelGeometry: { width: 131, resizing: false } });
  assert.equal(f.read().layout.workPanel.width, 131);
  assert.equal(f.read().layout.workPanel.minWidth, 244);
  f.updateShell({ panelGeometry: { width: 148, resizing: true } });
  assert.equal(f.read().layout.workPanel.width, 148);
  assert.equal(f.read().settled, false);
  assert.equal(f.get().workPanelWidth, 360);
});

test("tab labels use the strip titles and distinguish repeated subagent labels", () => {
  const f = fixture({ pluginViews: [{ ref: "demo.view/main", title: "Translated view" }] });
  f.get().openWorkPanelTab(tabs.pluginWorkPanelTab("demo.view", "main"));
  f.get().openSubagentTab("d1", "Worker");
  f.get().openSubagentTab("d2", "Worker");
  assert.deepEqual(f.read().layout.workPanel.tabs.map((tab) => tab.label), ["Translated view", "Worker#1", "Worker#2"]);
});

test("stale context and pending session switches reject before any mutation", () => {
  const f = fixture();
  const before = f.get();
  assert.throws(() => f.apply({ kind: "setWorkPanel", input: { visible: true } }, "old"), /context changed/i);
  assert.equal(f.get(), before);
  f.set({ selectingSessionId: "s2" });
  assert.throws(() => f.apply({ kind: "setWorkPanel", input: { visible: true } }), /session.*changing/i);
  assert.equal(f.get().workPanelOpen, false);
});

test("no-session and remote snapshots do not reveal retained local tabs", () => {
  const f = fixture();
  f.get().openWorkPanelTab(tabs.fileWorkPanelTab("/private/local.txt"));
  f.set({ activeSessionId: undefined });
  assert.deepEqual(f.read().layout.workPanel.tabs, []);
  assert.equal(f.read().layout.workPanel.activeTabId, null);
  f.set({ activeSessionId: "remote:r1" });
  assert.deepEqual(f.read().layout.workPanel.tabs, []);
});


test("opening a panel waits for its automatic sidebar yield before reporting stable layout", () => {
  const f = fixture({ workPanelOpen: true });
  f.updateShell({ containerWidth: 1000, sidebarWidth: 275, panelGeometry: { width: 275, resizing: false } });
  assert.equal(f.read().settled, false);
  f.updateShell({ sidebarCollapsed: true, panelGeometry: { width: 360, resizing: false } });
  assert.equal(f.read().settled, true);
  assert.equal(f.read().layout.workPanel.width, 360);
});


test("selected-session project identity cannot be replaced by an ahead-of-render workspace", () => {
  const f = fixture({ sessions: [{ id: "s1", projectPath: "/project-A" }], workspace: { path: "/project-B" } });
  f.get().openWorkPanelTab(tabs.fileWorkPanelTab("/project-A/private.txt"));
  assert.equal(f.read().projectPath, "/project-A");
  f.set({ selectingSessionId: "s2" });
  assert.throws(() => f.read(), /session.*changing/i);
});

test("entry animation is not a stable commit and live reads use actual rendered width", () => {
  const f = fixture({ workPanelOpen: true });
  let running = true;
  let width = 0;
  const element = {
    getAnimations: () => [{ playState: running ? "running" : "finished" }],
    getBoundingClientRect: () => ({ width }),
  };
  f.updateShell({ panelGeometry: { width: 360, resizing: false, element } });
  assert.equal(f.read().settled, false);
  assert.equal(f.read().layout.workPanel.width, 0);
  width = 180;
  assert.equal(f.read().layout.workPanel.width, 180);
  running = false;
  width = 360;
  assert.equal(f.read().settled, true);
  assert.equal(f.read().layout.workPanel.width, 360);
});
