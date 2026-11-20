import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createProjectSlice } = await import("../src/stores/slices/project-slice.ts");

/**
 * Issue #2455: a global New Task starts a temporary conversation, and an idle
 * conversation can leave its project or join one without losing anything.
 */
function fixture(t) {
  const createRequests = [];
  const moveRequests = [];
  let created = 0;
  let state = {
    activeSessionId: undefined, page: "chat", sessions: [], messages: [],
    sessionMeta: {}, pendingPlans: {}, planCheckpoints: {}, planningStates: {},
    runningSessions: {}, agentStatuses: {}, latestTurnResults: {}, sessionOutcomes: {},
    sessionCompactions: {}, sessionHistory: {}, retainedSessionIds: [], retainedTranscripts: {},
    workPanelContexts: {}, workPanelTabs: [], activeWorkPanelTabId: null,
    workPanelOpen: false, workPanelFileRequest: null, navStack: [], navIndex: -1,
    settings: {}, providers: [], providerModels: {}, recentModels: [], draftConfiguration: null,
    workspace: { path: "/synthetic/project", name: "project" }, activeProjectPath: "/synthetic/project",
    openProjectPaths: ["/synthetic/project", "/synthetic/other"], openProjects: [], projectMeta: {},
    queuedPrompts: {},
    refreshSessions: async () => {}, rememberModel: () => {}, showToast: () => {},
    resetWorkPanelContext: () => {},
  };
  const get = () => state;
  const set = (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
  const runtime = createSessionRuntime({ get, set });
  const withoutRecordKey = (record, key) => { const result = { ...record }; delete result[key]; return result; };
  t.mock.method(api, "createSession", async (input) => {
    createRequests.push(input);
    const id = `created-${++created}`;
    return { session: { id, title: "New task", mode: "agent", messageCount: 0,
      projectPath: input.projectPath ?? undefined, updatedAt: "2026-11-20T00:00:00Z" } };
  });
  t.mock.method(api, "moveSessionProject", async (sessionId, projectPath) => {
    moveRequests.push({ sessionId, projectPath });
    const session = state.sessions.find((item) => item.id === sessionId);
    // The host omits `projectPath` for a temporary session.
    const { projectPath: _old, ...rest } = session;
    return { session: projectPath === null ? rest : { ...rest, projectPath } };
  });
  t.mock.method(api, "setProject", async (path) => ({ workspace: { path, name: "project" } }));
  t.mock.method(api, "clearProject", async () => {});
  t.mock.method(api, "getOnboarding", async () => ({}));
  const coordination = createSessionCoordination({
    get, set, runtime, decorateSessions: (rows) => rows, withoutRecordKey,
    untitledTaskTitle: () => "New task",
  });
  Object.assign(state, createSessionSlice({
    get, set, runtime, decorateSessions: (rows) => rows, withoutRecordKey,
    ...coordination, getBootstrapGeneration: () => 0,
  }));
  const project = createProjectSlice({
    get, set, runtime, withoutRecordKey,
    withProjectDisplayName: (workspace) => workspace,
    promoteProjectPath: (paths, path) => [path, ...paths.filter((item) => item !== path)],
    removeProjectPath: (paths, path) => paths.filter((item) => item !== path),
    upsertWorkspace: (projects, workspace) => [...projects.filter((item) => item.path !== workspace.path), workspace],
    persistCurrentSidebar: () => {},
  });
  Object.assign(state, {
    moveSessionProject: project.moveSessionProject,
    // Stand-ins that keep only the visible-project effect.
    clearProject: async () => set({ workspace: null, activeProjectPath: undefined }),
    activateProject: async (path) => {
      const workspace = { path, name: "project" };
      set({ workspace, activeProjectPath: path });
      return workspace;
    },
    selectSession: async (id) => {
      const session = state.sessions.find((item) => item.id === id);
      if (session?.projectPath) await state.activateProject(session.projectPath);
      else await state.clearProject();
      set({ activeSessionId: id });
    },
  });
  return { get, set, createRequests, moveRequests };
}

test("global New Task starts a temporary conversation inside a project", async (t) => {
  const f = fixture(t);
  await f.get().newSession();
  assert.equal(f.createRequests.length, 1);
  assert.equal(f.createRequests[0].projectPath, undefined, "the active project is not inherited");
  assert.equal(f.get().workspace, null, "the visible project is released");
  assert.equal(f.get().sessions[0].projectPath, undefined);
});

test("an explicit project target still attaches the new conversation", async (t) => {
  const f = fixture(t);
  f.set({ workspace: null, activeProjectPath: undefined });
  await f.get().newSession({ projectPath: "/synthetic/other" });
  assert.equal(f.createRequests[0].projectPath, "/synthetic/other");
  assert.equal(f.get().workspace?.path, "/synthetic/other");
});

test("an idle conversation leaves its project and joins another", async (t) => {
  const f = fixture(t);
  f.set({
    activeSessionId: "s1",
    sessions: [{ id: "s1", title: "Work", mode: "agent", messageCount: 4,
      projectPath: "/synthetic/project", updatedAt: "2026-11-20T00:00:00Z" }],
  });

  assert.equal(await f.get().moveSessionProject("s1", null), true);
  assert.deepEqual(f.moveRequests.at(-1), { sessionId: "s1", projectPath: null });
  assert.equal(f.get().sessions[0].projectPath, undefined, "the stale project path is cleared");
  assert.equal(f.get().sessions[0].messageCount, 4, "the conversation keeps its transcript");
  assert.equal(f.get().workspace, null, "the active conversation's workspace follows it");
  assert.equal(f.get().activeSessionId, "s1", "the conversation stays open");

  assert.equal(await f.get().moveSessionProject("s1", "/synthetic/other"), true);
  assert.equal(f.get().sessions[0].projectPath, "/synthetic/other");
  assert.equal(f.get().workspace?.path, "/synthetic/other");
});

test("moving is refused for running sessions and unopened projects", async (t) => {
  const f = fixture(t);
  f.set({
    sessions: [{ id: "s1", title: "Work", mode: "agent", messageCount: 1, updatedAt: "2026-11-20T00:00:00Z" }],
    runningSessions: { s1: true },
  });
  assert.equal(await f.get().moveSessionProject("s1", "/synthetic/project"), false);
  f.set({ runningSessions: {} });
  assert.equal(await f.get().moveSessionProject("s1", "/not/open"), false);
  assert.equal(await f.get().moveSessionProject("s1", null), true, "already temporary is a no-op");
  assert.equal(f.moveRequests.length, 0);
});
