import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteApprovalRequestId } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteBackend } = await import("../electron/main/remote/remote-backend.ts");
const { createRemoteSessionCatalog } = await import("../electron/main/remote/remote-session-catalog.ts");
const { registerRemoteSessionIpc } = await import("../electron/main/ipc/remote-session-ipc.ts");

const session = (id = "s1") => ({
  id, title: "Remote work", projectId: "p1", workspaceLabel: "app", mode: "agent",
  permissionMode: "ask", status: "idle", planningState: "inactive", queuedTurnIds: [],
  revision: 1, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
});
const item = (id, content) => ({ id, turnId: "t1", itemType: "message", status: "completed", createdAt: "2026-10-10T00:00:00Z", content: { id, role: "assistant", content } });
const snapshot = (overrides = {}) => ({ session: session(), items: [], activeItems: [], pendingInputs: [], pendingApprovals: [], queuedTurns: [], hasMoreHistory: false, cursor: { epoch: "e1", sequence: 1 }, revision: 1, generatedAt: "2026-10-10T00:00:00Z", ...overrides });

function fixture() {
  const calls = [];
  const snapshots = [];
  let online = true;
  const router = createBackendRouter();
  const client = {
    async request(method, params) {
      assert.ok(online, "no remote call is allowed after disconnect");
      calls.push({ method, params });
      switch (method) {
        case "project/list": return { projects: [{ id: "p1", label: "app", archived: false }] };
        case "project/register": return { project: { id: "p1", label: "app", archived: false, path: params.path } };
        case "session/create": case "session/get": return { session: session() };
        case "session/list": return { sessions: [session()] };
        case "session/attach": return { snapshot: snapshot({ items: [item("m2", "Hello")], hasMoreHistory: true }) };
        case "session/history": return { items: [item("m1", "Earlier")], hasMore: false };
        case "turn/start": return { accepted: true, turn: { id: "t1" } };
        case "approval/respond": return { status: "resolved" };
        case "workspace/list": return { entries: [{ name: "README.md", kind: "file", size: 5 }] };
        case "workspace/read": return { kind: "text", content: "Hello", size: 5 };
        case "workspace/diff": return { repo: true, clean: false, files: [{ path: "README.md" }] };
        default: throw new Error(`unexpected method ${method}`);
      }
    },
  };
  const backend = createRemoteBackend({ hostKey: "h1", hostLabel: "Linux host", client, onSnapshot: (value) => snapshots.push(value) });
  const host = { hostKey: "h1", label: "Linux host", client, connection: {
    async ensureSession(id) { router.registerBackend(`remote:h1:${id}`, backend); },
  } };
  const catalog = createRemoteSessionCatalog({ getHost: (key) => key === "h1" && online ? host : undefined });
  return { calls, snapshots, router, client, backend, host, catalog,
    disconnect() { online = false; router.unregisterBackend("remote:h1:s1"); },
    reconnect() { online = true; router.registerBackend("remote:h1:s1", backend); },
  };
}

test("remote user path: project, session, prompt, approval, files, reconnect without replay", async () => {
  const f = fixture();
  assert.equal((await f.catalog.projects("h1"))[0].id, "p1");
  const project = await f.catalog.registerProject("h1", "/srv/app");
  const created = await f.catalog.createSession({ hostKey: "h1", projectId: project.id });
  assert.equal(created.source, "remote");
  assert.equal(created.remoteHostLabel, "Linux host");
  assert.equal(created.projectPath, undefined, "remote root cannot become a local workspace");
  assert.equal(created.capabilities.canConfigureModel, false);
  assert.equal(created.capabilities.canAttach, false);
  const route = async (channel, input) => (await f.router.route(channel, [input])).value;
  const detail = await route(IPC.invoke.sessionGet, { id: created.id, messageLimit: 1 });
  assert.equal(detail.session.messages[0].content, "Hello");
  assert.equal(f.snapshots.length, 1);
  assert.equal((await route(IPC.invoke.agentPrompt, { sessionId: created.id, content: "Fix it" })).accepted, true);
  await route(IPC.invoke.toolResolvePermission, { requestId: makeRemoteApprovalRequestId(created.id, "a1"), decision: "allow-once" });
  assert.equal((await route(IPC.invoke.fsList, { sessionId: created.id, path: "" })).entries[0].name, "README.md");
  assert.equal((await route(IPC.invoke.fsRead, { sessionId: created.id, path: "README.md" })).content, "Hello");
  assert.equal((await route(IPC.invoke.workspaceDiff, { sessionId: created.id })).clean, false);
  f.disconnect();
  assert.equal(f.catalog.summaries()[0].capabilities.canPrompt, false);
  await assert.rejects(route(IPC.invoke.fsRead, { sessionId: created.id, path: "README.md" }), { errorCode: "AGENT_UNAVAILABLE" });
  f.reconnect();
  await f.catalog.sessions("h1");
  assert.equal(f.catalog.summaries()[0].capabilities.canPrompt, true);
  await route(IPC.invoke.sessionGet, { id: created.id });
  assert.equal(f.calls.filter((entry) => entry.method === "turn/start").length, 1, "recovery must not replay prompt");
});

test("remote history pages older items and rejects foreign or unknown cursors", async () => {
  const { backend, calls } = fixture();
  const first = await backend.invoke(IPC.invoke.sessionGet, [{ id: "remote:h1:s1", messageLimit: 1 }]);
  const before = first.session.messageStart;
  assert.ok(before > 0);
  const older = await backend.invoke(IPC.invoke.sessionGet, [{ id: "remote:h1:s1", messageBefore: before }]);
  assert.equal(older.session.messages[0].content, "Earlier");
  assert.equal(older.session.hasMoreBefore, false);
  assert.equal(calls.find((entry) => entry.method === "session/history").params.beforeItemId, "m2");
  await assert.rejects(backend.invoke(IPC.invoke.sessionGet, [{ id: "remote:h1:s2", messageBefore: before }]), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(backend.invoke(IPC.invoke.sessionGet, [{ id: "remote:h1:s1", messageBefore: 123 }]), { errorCode: "INVALID_ARGUMENT" });
});

test("remote model selection and invalid paths are rejected before network dispatch", async () => {
  const { backend, calls } = fixture();
  await assert.rejects(backend.invoke(IPC.invoke.sessionConfigure, ["remote:h1:s1", { providerId: "local-provider" }]), { errorCode: "CAPABILITY_UNAVAILABLE" });
  await assert.rejects(backend.invoke(IPC.invoke.fsRead, [{ sessionId: "remote:h1:s1", path: "bad\0path" }]), { errorCode: "INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
});

test("late session list after host removal cannot resurrect cached rows", async () => {
  let finish;
  let host = { hostKey: "h", label: "H", client: { request: () => new Promise((resolve) => { finish = resolve; }) }, connection: { ensureSession: async () => {} } };
  const catalog = createRemoteSessionCatalog({ getHost: () => host });
  const listing = catalog.sessions("h");
  host = undefined;
  catalog.forget("h");
  finish({ sessions: [session()] });
  await assert.rejects(listing, { errorCode: "AGENT_UNAVAILABLE" });
  assert.deepEqual(catalog.summaries(), []);
});

test("remote entry IPC validates fields and strips unrelated model settings", async () => {
  const handlers = new Map();
  const calls = [];
  const boot = {
    createSession: async (input) => { calls.push(input); return session(); },
    registerProject: async () => { throw new Error("must not dispatch"); },
    syncProviders: async () => { throw new Error("must not dispatch"); },
  };
  registerRemoteSessionIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, () => boot);
  await handlers.get(IPC.invoke.remoteHostCreateSession)({ hostKey: "h", projectId: "p", providerId: "local", modelId: "local" });
  assert.deepEqual(calls[0], { hostKey: "h", projectId: "p" });
  for (const request of [{ hostKey: "h" }, { hostKey: "bad:key", projectId: "p" }, { hostKey: "h", projectId: "p", mode: "unknown" }]) {
    await assert.rejects(handlers.get(IPC.invoke.remoteHostCreateSession)(request), { errorCode: "INVALID_ARGUMENT" });
  }
  await assert.rejects(handlers.get(IPC.invoke.remoteHostRegisterProject)({ hostKey: "h", path: "relative" }), { errorCode: "INVALID_ARGUMENT" });
  for (const providerIds of [[], ["x", "x"], [null]]) {
    await assert.rejects(handlers.get(IPC.invoke.remoteHostSyncProviders)({ hostKey: "h", providerIds, setDefault: true }), { errorCode: "INVALID_ARGUMENT" });
  }
});
