import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as sidebar from "../src/lib/sidebar-preferences.ts";
import { settleBootstrapRequests } from "../src/lib/bootstrap-result.ts";

const source = await readFile(new URL("../src/stores/app-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("app-store.ts", source, ts.ScriptTarget.Latest, true);
let bootstrap;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "bootstrap") bootstrap = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
const code = ts.transpileModule(`let bootstrapGeneration = 0; return (${bootstrap.getText(ast)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

test("bootstrap recovers registered project tabs when Chromium state is missing", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  let state = { ...sidebar.loadSidebarPreferences(), navStack: [], navIndex: -1 };
  const bindings = {
    get: () => ({ ...state, refreshPluginViews: async () => {} }),
    set: update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    api: {
      getSettings: async () => ({ defaultMode: "agent" }), getVersion: async () => ({ protocolVersion: 11 }),
      health: async () => ({ ok: true }), listSessions: async () => ({ sessions: [] }),
      listProviders: async () => ({ providers: [] }), getProject: async () => ({ workspace: { path: "/active" } }),
      getOnboarding: async () => ({}), listPlugins: async () => ({ plugins: [] }),
      listNotifications: async () => ({ notifications: [], unreadCount: 0 }), pendingPlans: async () => ({ plans: [] }),
      getSidebarPreferences: async () => null, setSidebarPreferences: async () => {},
      listProjects: async () => ({ projects: [{ path: "/synthetic/alpha" }, { path: "/synthetic/beta" }] }),
    },
    normalizeMode: mode => mode, migrateKeybindingOverrides: value => value,
    restoreSidebarPreferences: sidebar.restoreSidebarPreferences, sidebarPreferencesState: sidebar.sidebarPreferencesState,
    settleBootstrapRequests, PROTOCOL_VERSION: 11,
    withProjectDisplayName: value => value, projectWorkspaceFromPath: path => ({ path }),
    promoteProjectPath: (paths, path) => [...new Set([...paths, path])],
    upsertWorkspace: (projects, workspace) => [...projects.filter(p => p.path !== workspace.path), workspace],
    decorateSessions: value => value, isPendingPlan: () => false, latestSessionOutcomes: () => ({}),
    saveSidebarPreferences: sidebar.saveSidebarPreferences,
    preferencesFromState: value => value, rememberProject: () => {},
    switchWorkPanelSession: () => ({}), clearSessionPanes: () => ({}),
  };
  const run = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  await run();
  assert.equal(state.error, undefined);
  assert.deepEqual(state.openProjectPaths, ["/synthetic/alpha", "/synthetic/beta", "/active"]);
});
