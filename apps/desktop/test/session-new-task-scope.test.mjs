import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");

/**
 * Issue #2455: a global New Task must start a standalone, path-less
 * conversation. Only an explicit project target (a project row's +, the
 * project index, or a worktree) may attach the new conversation to a project.
 */
function fixture(t) {
  let created = 0;
  const createRequests = [];
  const activated = [];
  let state = {
    activeSessionId: undefined, page: "chat", sessions: [], messages: [],
    sessionMeta: {}, pendingPlans: {}, planCheckpoints: {}, planningStates: {},
    runningSessions: {}, agentStatuses: {}, latestTurnResults: {}, sessionOutcomes: {},
    sessionCompactions: {}, sessionHistory: {}, retainedSessionIds: [], retainedTranscripts: {},
    workPanelContexts: {}, workPanelTabs: [], activeWorkPanelTabId: null,
    workPanelOpen: false, workPanelFileRequest: null, navStack: [], navIndex: -1,
    settings: {}, providers: [], providerModels: {}, recentModels: [], draftConfiguration: null,
    workspace: { path: "/synthetic/project" }, activeProjectPath: "/synthetic/project",
    defaultProjectPath: "/synthetic/project", queuedPrompts: {},
    refreshSessions: async () => {}, rememberModel: () => {}, showToast: () => {},
    resetWorkPanelContext: () => {},
  };
  const get = () => state;
  const set = update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
  const runtime = createSessionRuntime({ get, set });
  const withoutRecordKey = (record, key) => { const result = { ...record }; delete result[key]; return result; };
  t.mock.method(api, "createSession", async input => {
    createRequests.push(input);
    const id = `created-${++created}`;
    return { session: { id, title: "New task", mode: "agent", messageCount: 0,
      projectPath: input.projectPath ?? null, updatedAt: "2026-11-20T00:00:00Z" } };
  });
  t.mock.method(api, "setProject", async path => {
    activated.push(path);
    return { workspace: { path, name: "project" } };
  });
  t.mock.method(api, "clearProject", async () => {});
  t.mock.method(api, "getOnboarding", async () => ({}));
  const coordination = createSessionCoordination({
    get, set, runtime, decorateSessions: rows => rows, withoutRecordKey,
    untitledTaskTitle: () => "New task",
  });
  Object.assign(state, createSessionSlice({
    get, set, runtime, decorateSessions: rows => rows, withoutRecordKey,
    ...coordination, getBootstrapGeneration: () => 0,
  }));
  // Stand-ins for the project slice; these tests only need the state effects
  // that decide the new session's project scope.
  Object.assign(state, {
    clearProject: async () => {
      set({ workspace: null, activeProjectPath: undefined });
    },
    activateProject: async path => {
      activated.push(path);
      const workspace = { path, name: "project" };
      set({ workspace, activeProjectPath: path });
      return workspace;
    },
  });
  return { get, set, runtime, createRequests, activated, created: () => created };
}

test("global New Task starts a temporary conversation even inside a project", async t => {
  const f = fixture(t);
  await f.get().newSession();
  assert.equal(f.created(), 1);
  assert.equal(f.createRequests[0].projectPath, undefined,
    "global New Task must not pass the active project to session.create");
  assert.equal(f.get().workspace, null, "the active project must be released");
  assert.equal(f.get().activeProjectPath, undefined);
  assert.equal(f.get().sessions[0].projectPath, null);
});

test("global New Task ignores a project's reusable empty slot", async t => {
  const f = fixture(t);
  f.set({
    sessions: [{
      id: "project-empty", title: "New task", mode: "agent", messageCount: 0,
      projectPath: "/synthetic/project", updatedAt: "2026-11-20T00:00:00Z",
    }],
  });
  await f.get().newSession();
  assert.equal(f.created(), 1, "the project's empty slot must not be reused");
  assert.equal(f.createRequests[0].projectPath, undefined);
  assert.equal(f.get().sessions.find(session => session.id === "project-empty")?.messageCount, 0);
  assert.notEqual(f.get().activeSessionId, "project-empty");
});

test("an explicit project target still attaches the new conversation", async t => {
  const f = fixture(t);
  f.set({ workspace: null, activeProjectPath: undefined });
  await f.get().newSession({ projectPath: "/synthetic/other" });
  assert.equal(f.created(), 1);
  assert.equal(f.createRequests[0].projectPath, "/synthetic/other");
  assert.deepEqual(f.activated, ["/synthetic/other"]);
  assert.equal(f.get().workspace?.path, "/synthetic/other");
  assert.equal(f.get().sessions[0].projectPath, "/synthetic/other");
});

test("an explicit null target still clears the project", async t => {
  const f = fixture(t);
  await f.get().newSession({ projectPath: null });
  assert.equal(f.created(), 1);
  assert.equal(f.createRequests[0].projectPath, undefined);
  assert.equal(f.get().workspace, null);
  assert.equal(f.get().sessions[0].projectPath, null);
});
