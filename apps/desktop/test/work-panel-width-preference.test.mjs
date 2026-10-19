import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as workPanelResize from "../src/lib/work-panel-resize.ts";
import * as workPanelTabs from "../src/lib/work-panel-tabs.ts";

const STORAGE_KEY = "pi.desktop.workPanel";

/** Runs the real work-panel slice; only the Desktop API is stubbed. */
function loadSlice() {
  const relative = "../src/stores/slices/work-panel-slice.ts";
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const imports = {
    "../../lib/api": { api: {} },
    "../../lib/remote-session-safety": { isRemoteSession: () => false },
    "../../lib/work-panel-tabs": workPanelTabs,
    "../../lib/work-panel-resize": workPanelResize,
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { createWorkPanelSlice, loadWorkPanelWidth } = loadSlice();

function installStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  return values;
}

function createStore(overrides = {}) {
  let state = {
    activeSessionId: "session-1",
    workPanelOpen: true,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelContexts: {},
    workPanelFileRequest: null,
    workPanelWidth: 360,
    workPanelYieldedWidth: null,
    sessions: [],
    pluginViews: [],
    ...overrides,
  };
  const get = () => state;
  const set = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const slice = createWorkPanelSlice({
    get,
    set,
    isSessionSelectionPending: () => false,
  });
  state = { ...state, ...slice };
  return get;
}

test("a width lent to a reopened sidebar is never stored", () => {
  const storage = installStorage({ [STORAGE_KEY]: JSON.stringify({ width: 360 }) });
  const get = createStore();

  get().setWorkPanelYieldedWidth(131);

  assert.equal(get().workPanelYieldedWidth, 131);
  assert.equal(get().workPanelWidth, 360);
  assert.equal(storage.get(STORAGE_KEY), JSON.stringify({ width: 360 }));

  get().setWorkPanelYieldedWidth(null);
  assert.equal(get().workPanelYieldedWidth, null);
});

test("an explicit resize ends the loan and keeps the regular minimum", () => {
  const storage = installStorage();
  const get = createStore({ workPanelYieldedWidth: 131 });

  get().setWorkPanelWidth(131);

  assert.equal(get().workPanelYieldedWidth, null);
  assert.equal(get().workPanelWidth, workPanelResize.WORK_PANEL_MIN_WIDTH);
  assert.equal(
    storage.get(STORAGE_KEY),
    JSON.stringify({ width: workPanelResize.WORK_PANEL_MIN_WIDTH }),
  );

  get().setWorkPanelWidth(500);
  assert.equal(get().workPanelWidth, 500);
});

test("a stored width below the regular minimum is restored to it on load", () => {
  // Earlier builds stored the width a sidebar reopen borrowed.
  installStorage({ [STORAGE_KEY]: JSON.stringify({ width: 131 }) });
  assert.equal(loadWorkPanelWidth(), workPanelResize.WORK_PANEL_MIN_WIDTH);
  installStorage({ [STORAGE_KEY]: JSON.stringify({ width: 1 }) });
  assert.equal(loadWorkPanelWidth(), workPanelResize.WORK_PANEL_MIN_WIDTH);
  installStorage({ [STORAGE_KEY]: JSON.stringify({ width: 500 }) });
  assert.equal(loadWorkPanelWidth(), 500);
  installStorage();
  assert.equal(loadWorkPanelWidth(), workPanelResize.WORK_PANEL_DEFAULT_WIDTH);
});
