import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { openRemoteProjectSession, remoteProjectForSession } = await import("../src/lib/remote-project-session.ts");
const { listRemoteProjects, groupRemoteProjectSessions } = await import("../src/lib/remote-project-catalog.ts");
const { createNavigationIntentController } = await import("../src/lib/navigation-intent.ts");

const project = { hostKey: "ssh-one", projectId: "project", label: "app" };
const remote = (hostKey = project.hostKey, count = 0) => ({
  id: `remote:${hostKey}:one`, source: "remote", remoteHostKey: hostKey,
  remoteProjectId: project.projectId, remoteWorkspaceLabel: "app", messageCount: count,
  title: "Chat", updatedAt: "2026-10-11T00:00:00Z",
});
const originalRead = api.getSession;
beforeEach(() => { api.getSession = async () => ({ session: { ...remote(), messages: [], hasMoreBefore: false } }); });
afterEach(() => { api.getSession = originalRead; });
function fixture(sessions = []) {
  const nav = createNavigationIntentController();
  const selections = [];
  let state = { sessions, sessionMeta: {}, runningSessions: {}, workspace: { path: "/local/app" },
    selectSession: async (id, options) => { selections.push({ id, options }); } };
  return {
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    runtime: { pendingNewSessionRequests: new Map(), submittedComposerDrafts: new Map(),
      beginNavigationIntent: nav.begin, navigationIntentIsCurrent: nav.isCurrent,
      liveMessageCountForSession: () => 0 },
    nav, selections,
  };
}

test("remote New chat reuses an empty chat only in the same host/project", async () => {
  const f = fixture([remote("ssh-two"), remote()]);
  await openRemoteProjectSession(f, project);
  assert.equal(f.selections[0].id, "remote:ssh-one:one");
  assert.equal(f.get().workspace.path, "/local/app");
  assert.deepEqual(remoteProjectForSession(remote()), project);
  assert.equal(remoteProjectForSession({ ...remote(), id: "local", source: "desktop" }), undefined);
});

test("remote project creation coalesces duplicate clicks and keeps local paths isolated", async () => {
  const original = api.createRemoteSession;
  let resolve;
  const calls = [];
  api.createRemoteSession = (input) => { calls.push(input); return new Promise((done) => { resolve = done; }); };
  try {
    const f = fixture([remote("ssh-two")]);
    const first = openRemoteProjectSession(f, project);
    const duplicate = openRemoteProjectSession(f, project);
    resolve({ session: { ...remote(), projectPath: "/remote/app" } });
    await Promise.all([first, duplicate]);
    assert.deepEqual(calls, [{ hostKey: "ssh-one", projectId: "project", mode: "agent", permissionMode: "ask" }]);
    assert.equal(f.selections.length, 1);
    assert.equal(f.get().sessions[0].projectPath, undefined);
    assert.equal(f.get().workspace.path, "/local/app");
    assert.equal(f.runtime.pendingNewSessionRequests.size, 0);
  } finally { api.createRemoteSession = original; }
});

test("navigation during a remote create preserves its result without stealing focus", async () => {
  const original = api.createRemoteSession;
  let resolve;
  api.createRemoteSession = () => new Promise((done) => { resolve = done; });
  try {
    const f = fixture();
    const request = openRemoteProjectSession(f, project);
    f.nav.begin();
    resolve({ session: remote() });
    await request;
    assert.equal(f.get().sessions.length, 1);
    assert.equal(f.selections.length, 0);
  } finally { api.createRemoteSession = original; }
});

test("a busy or nonempty chat is never reused, and failed creation can be retried", async () => {
  const original = api.createRemoteSession;
  const f = fixture([remote()]);
  f.get().runningSessions[remote().id] = true;
  let attempts = 0;
  api.createRemoteSession = async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    return { session: { ...remote(), id: "remote:ssh-one:two" } };
  };
  try {
    await assert.rejects(openRemoteProjectSession(f, project), /offline/);
    await openRemoteProjectSession(f, project);
    assert.equal(attempts, 2);
    assert.equal(f.selections[0].id, "remote:ssh-one:two");
    assert.equal(f.runtime.pendingNewSessionRequests.size, 0);
  } finally { api.createRemoteSession = original; }
});

test("remote project discovery distinguishes identical paths and labels across hosts", () => {
  const hosts = [{ hostKey: "ssh-one", label: "One", connected: true }, { hostKey: "ssh-two", label: "Two", connected: false }];
  const projects = listRemoteProjects(hosts, [{ hostKey: "ssh-one", projects: [{ id: "project", label: "app", archived: false }] }], [remote(), remote("ssh-two")]);
  assert.equal(projects.length, 2);
  assert.notEqual(projects[0].key, projects[1].key);
  assert.equal(projects[0].connected, true);
  assert.equal(projects[1].connected, false);
  assert.deepEqual(listRemoteProjects(hosts, [{ hostKey: "ssh-one", projects: [{ id: "project", label: "app", archived: true }] }], [remote()]), []);
});

test("remote project groups share sorted visible order with range selection", () => {
  const a1 = { ...remote(), id: "a1", title: "Zulu" };
  const b1 = { ...remote("ssh-two"), id: "b1", title: "Other host" };
  const a2 = { ...remote(), id: "a2", title: "Alpha" };
  const groups = groupRemoteProjectSessions([a1, b1, a2], (left, right) => left.title.localeCompare(right.title));
  assert.deepEqual(groups.map((group) => group.sessions.map((session) => session.id)), [["a2", "a1"], ["b1"]]);
  assert.deepEqual(groups.flatMap((group) => group.sessions.map((session) => session.id)), ["a2", "a1", "b1"]);
});

test("a cold RACP catalog count of zero never reuses a chat with actual history", async () => {
  const { createRemoteSessionCatalog } = await import("../electron/main/remote/remote-session-catalog.ts");
  const host = {
    hostKey: "ssh-one", label: "Host", connection: { ensureSession: async () => {} },
    client: { request: async () => ({ sessions: [{ id: "one", title: "Previous chat", projectId: "project",
      workspaceLabel: "app", mode: "agent", permissionMode: "ask", status: "idle", planningState: "inactive",
      queuedTurnIds: [], createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" }] }) },
  };
  const catalog = createRemoteSessionCatalog({ getHost: () => host });
  const rows = await catalog.sessions("ssh-one");
  assert.equal(rows[0].messageCount, 0, "list count is a projection, not proof of emptiness");
  const f = fixture(rows);
  api.getSession = async () => ({ session: { ...rows[0], messages: [{ id: "m1", role: "user", content: "Earlier request" }] } });
  const original = api.createRemoteSession;
  api.createRemoteSession = async () => ({ session: { ...remote(), id: "remote:ssh-one:new" } });
  try {
    await openRemoteProjectSession(f, project);
    assert.equal(f.selections[0].id, "remote:ssh-one:new");
  } finally { api.createRemoteSession = original; }
});

test("a history confirmation cannot reuse a chat after a newer navigation", async () => {
  const f = fixture([remote()]);
  let resolve;
  api.getSession = () => new Promise((done) => { resolve = done; });
  const pending = openRemoteProjectSession(f, project);
  f.nav.begin();
  resolve({ session: { ...remote(), messages: [] } });
  await pending;
  assert.equal(f.selections.length, 0);
});

test("a chat archived during history confirmation is not reused", async () => {
  const f = fixture([remote()]);
  let resolve;
  api.getSession = () => new Promise((done) => { resolve = done; });
  const original = api.createRemoteSession;
  api.createRemoteSession = async () => ({ session: { ...remote(), id: "remote:ssh-one:new" } });
  try {
    const pending = openRemoteProjectSession(f, project);
    f.get().sessionMeta[remote().id] = { archived: true };
    resolve({ session: { ...remote(), messages: [] } });
    await pending;
    assert.equal(f.selections[0].id, "remote:ssh-one:new");
  } finally { api.createRemoteSession = original; }
});
