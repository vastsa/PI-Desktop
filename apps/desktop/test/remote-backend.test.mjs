import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { makeRemoteApprovalRequestId, makeRemoteSessionId } = await import(
  "../electron/main/remote/backend-router.ts"
);
const { racpSessionToSummary, snapshotToSessionDetail } = await import(
  "../electron/main/remote/remote-transcript.ts"
);
const { createRemoteBackend } = await import(
  "../electron/main/remote/remote-backend.ts"
);

const HOST_KEY = "hostA";
const HOST_SESSION_ID = "sess-1";
const REMOTE_SESSION_ID = makeRemoteSessionId(HOST_KEY, HOST_SESSION_ID);

/**
 * A fixture `RacpSession` shaped just like the schema; individual tests override
 * only the fields they care about via spread.
 */
function makeRacpSession(overrides = {}) {
  return {
    id: HOST_SESSION_ID,
    title: "Remote session",
    mode: "chat",
    status: "idle",
    planningState: "inactive",
    permissionMode: "default",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function makeRacpTurn(overrides = {}) {
  return {
    id: "turn-1",
    sessionId: HOST_SESSION_ID,
    status: "running",
    admission: "reject_if_busy",
    effectivePermissionMode: "default",
    ...overrides,
  };
}

function makeRacpSnapshot(overrides = {}) {
  return {
    session: makeRacpSession(),
    queuedTurns: [],
    items: [],
    activeItems: [],
    pendingApprovals: [],
    pendingInputs: [],
    hasMoreHistory: false,
    cursor: { epoch: "e", sequence: 0 },
    revision: 1,
    generatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

/** A minimal RacpClient double that records every request and returns queued
 * responses. Each entry maps a RACP method to a value or an error to throw. */
function fakeClient(responses = {}) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      const handler = responses[method];
      if (typeof handler === "function") return handler(params);
      if (handler === undefined) {
        throw Object.assign(new Error(`no fake for ${method}`), { errorCode: "INTERNAL" });
      }
      return handler;
    },
  };
}

function makeBackend(responses = {}, extra = {}) {
  const client = fakeClient(responses);
  const backend = createRemoteBackend({
    hostKey: HOST_KEY,
    client,
    // A deterministic id keeps the recorded request context stable in assertions.
    newRequestId: () => "req-const",
    ...extra,
  });
  return { backend, client };
}

test("racpSessionToSummary maps the host-agnostic renderer summary", () => {
  const session = makeRacpSession({ mode: "agent", permissionMode: "allow" });
  const summary = racpSessionToSummary(REMOTE_SESSION_ID, session, 7);
  assert.equal(summary.id, REMOTE_SESSION_ID);
  assert.equal(summary.source, "remote");
  assert.equal(summary.mode, "agent");
  assert.equal(summary.permissionMode, "allow");
  // RACP never carries thinkingLevel; it defaults to "off" for the renderer.
  assert.equal(summary.thinkingLevel, "off");
  assert.equal(summary.messageCount, 7);
});

test("snapshotToSessionDetail lifts snapshot items directly into the transcript", () => {
  const snapshot = makeRacpSnapshot({
    hasMoreHistory: true,
    items: [
      { id: "i1", turnId: "t1", itemType: "message", status: "completed", createdAt: "x", content: { role: "user", text: "hi" } },
      { id: "i2", turnId: "t1", itemType: "message", status: "completed", createdAt: "x", content: { role: "assistant", text: "hello" } },
    ],
  });
  const detail = snapshotToSessionDetail(REMOTE_SESSION_ID, snapshot);
  assert.equal(detail.id, REMOTE_SESSION_ID);
  assert.equal(detail.hasMoreBefore, true);
  assert.equal(detail.hasMoreAfter, false);
  assert.equal(detail.messageCount, 2);
  assert.deepEqual(detail.messages[0], { role: "user", text: "hi" });
});

test("handles() covers exactly the channels the remote profile serves", () => {
  const { backend } = makeBackend();
  const covered = [
    IPC.invoke.agentPrompt,
    IPC.invoke.agentQueuePush,
    IPC.invoke.agentQueueList,
    IPC.invoke.agentStop,
    IPC.invoke.agentAbort,
    IPC.invoke.agentCompact,
    IPC.invoke.agentGetStatus,
    IPC.invoke.agentSteer,
    IPC.invoke.sessionGet,
    IPC.invoke.sessionConfigure,
    IPC.invoke.sessionFork,
    IPC.invoke.sessionRename,
    IPC.invoke.sessionDelete,
    IPC.invoke.toolResolvePermission,
    IPC.invoke.askToolResolve,
    IPC.invoke.plansResolve,
    IPC.invoke.plansPending,
  ];
  for (const channel of covered) assert.ok(backend.handles(channel), `${channel} should be handled`);
  // Unrelated desktop channels remain local.
  assert.equal(backend.handles(IPC.invoke.appSettings ?? "pi-desktop/settings/get"), false);
  assert.equal(backend.handles("pi-desktop/anything/unknown"), false);
});

test("agentPrompt starts a turn with reject_if_busy and returns the local response shape", async () => {
  const turn = makeRacpTurn({ id: "turn-42" });
  const { backend, client } = makeBackend({
    "turn/start": () => ({ accepted: true, turn }),
  });
  const result = await backend.invoke(IPC.invoke.agentPrompt, [
    { sessionId: REMOTE_SESSION_ID, content: "hi", sessionMessageId: "m1", messageId: "u1" },
  ]);
  assert.deepEqual(result, { accepted: true, turnId: "turn-42" });
  assert.equal(client.calls[0].method, "turn/start");
  assert.equal(client.calls[0].params.sessionId, HOST_SESSION_ID);
  assert.equal(client.calls[0].params.admission, "reject_if_busy");
  assert.deepEqual(client.calls[0].params.input, {
    text: "hi",
    sessionMessageId: "m1",
    messageId: "u1",
  });
});

test("agentPrompt with attachments raises CAPABILITY_UNAVAILABLE without any RACP call", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke(IPC.invoke.agentPrompt, [
      { sessionId: REMOTE_SESSION_ID, content: "hi", attachments: [{ id: "a" }] },
    ]),
    (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(client.calls.length, 0);
});

test("agentQueuePush queues with the local content, since RACP turns carry none", async () => {
  const turn = makeRacpTurn({ id: "turn-q", admission: "queue", queuePosition: 2 });
  const { backend, client } = makeBackend({
    "turn/start": () => ({ accepted: true, turn }),
  });
  const result = await backend.invoke(IPC.invoke.agentQueuePush, [
    { sessionId: REMOTE_SESSION_ID, content: "pushed prompt", idempotencyKey: "k1" },
  ]);
  assert.equal(result.id, "turn-q");
  assert.equal(result.sessionId, REMOTE_SESSION_ID);
  assert.equal(result.content, "pushed prompt");
  assert.equal(result.position, 2);
  assert.equal(client.calls[0].params.admission, "queue");
  assert.equal(client.calls[0].params.idempotencyKey, "k1");
});

test("agentQueueList reads the snapshot and renders entries without a prompt text", async () => {
  const { backend } = makeBackend({
    "session/attach": () => ({
      session: makeRacpSession(),
      snapshot: makeRacpSnapshot({
        queuedTurns: [
          makeRacpTurn({ id: "q1", admission: "queue", queuePosition: 1 }),
          makeRacpTurn({ id: "q2", admission: "queue" }),
        ],
      }),
    }),
  });
  const result = await backend.invoke(IPC.invoke.agentQueueList, [
    { sessionId: REMOTE_SESSION_ID },
  ]);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].id, "q1");
  assert.equal(result.entries[0].sessionId, REMOTE_SESSION_ID);
  // RACP turns do not carry queued prompt text; the entry still renders.
  assert.equal(result.entries[0].content, "");
  assert.equal(result.entries[0].position, 1);
  // A missing queuePosition falls back to index + 1.
  assert.equal(result.entries[1].position, 2);
});

test("agentStop resolves the active turn when the renderer omits turnId", async () => {
  const { backend, client } = makeBackend({
    "session/get": () => ({ session: makeRacpSession({ activeTurnId: "turn-active" }) }),
    "turn/stop": () => ({ ok: true }),
  });
  const result = await backend.invoke(IPC.invoke.agentStop, [
    { sessionId: REMOTE_SESSION_ID },
  ]);
  assert.deepEqual(result, { requested: true });
  assert.equal(client.calls[0].method, "session/get");
  assert.equal(client.calls[1].method, "turn/stop");
  assert.equal(client.calls[1].params.turnId, "turn-active");
});

test("agentStop reports requested=false when the session has no active turn", async () => {
  const { backend, client } = makeBackend({
    "session/get": () => ({ session: makeRacpSession() }),
  });
  const result = await backend.invoke(IPC.invoke.agentStop, [
    { sessionId: REMOTE_SESSION_ID },
  ]);
  assert.deepEqual(result, { requested: false });
  // No turn/stop is sent when there is nothing to stop.
  assert.equal(client.calls.length, 1);
});

test("agentAbort maps to turn/interrupt", async () => {
  const { backend, client } = makeBackend({
    "turn/interrupt": () => ({ ok: true }),
  });
  const result = await backend.invoke(IPC.invoke.agentAbort, [
    { sessionId: REMOTE_SESSION_ID, turnId: "explicit-turn" },
  ]);
  assert.deepEqual(result, { aborted: true });
  assert.equal(client.calls[0].method, "turn/interrupt");
  assert.equal(client.calls[0].params.turnId, "explicit-turn");
});

test("agentSteer refuses with CAPABILITY_UNAVAILABLE — no RACP counterpart exists", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke(IPC.invoke.agentSteer, [{ sessionId: REMOTE_SESSION_ID }]),
    (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(client.calls.length, 0);
});

test("agentGetStatus lifts session status/planning into the local shape", async () => {
  const session = makeRacpSession({
    status: "waiting_permission",
    activeTurnId: "turn-x",
    planningState: "awaiting_approval",
  });
  const { backend } = makeBackend({ "session/get": () => ({ session }) });
  const { status } = await backend.invoke(IPC.invoke.agentGetStatus, [
    { sessionId: REMOTE_SESSION_ID },
  ]);
  assert.equal(status.sessionId, REMOTE_SESSION_ID);
  assert.equal(status.currentTurnId, "turn-x");
  assert.equal(status.isRunning, false);
  assert.equal(status.pendingToolConfirmations, 1);
  assert.equal(status.planningState, "awaiting_approval");
});

test("sessionGet returns SessionDetail built from the snapshot", async () => {
  const { backend } = makeBackend({
    "session/attach": () => ({
      session: makeRacpSession(),
      snapshot: makeRacpSnapshot({
        items: [
          { id: "i1", turnId: "t1", itemType: "message", status: "completed", createdAt: "x", content: { role: "user", text: "hi" } },
        ],
      }),
    }),
  });
  const { session } = await backend.invoke(IPC.invoke.sessionGet, [
    { id: REMOTE_SESSION_ID },
  ]);
  assert.equal(session.id, REMOTE_SESSION_ID);
  assert.equal(session.messages.length, 1);
});

test("sessionGet errors when the host returns no snapshot", async () => {
  const { backend } = makeBackend({
    "session/attach": () => ({ session: makeRacpSession() }),
  });
  await assert.rejects(
    backend.invoke(IPC.invoke.sessionGet, [{ id: REMOTE_SESSION_ID }]),
    (error) => error.errorCode === "INTERNAL",
  );
});

test("sessionConfigure forwards only the fields the renderer set", async () => {
  const { backend, client } = makeBackend({
    "session/configure": () => ({ session: makeRacpSession({ mode: "agent" }) }),
  });
  await backend.invoke(IPC.invoke.sessionConfigure, [REMOTE_SESSION_ID, { mode: "agent" }]);
  assert.equal(client.calls[0].method, "session/configure");
  assert.deepEqual(client.calls[0].params, { sessionId: HOST_SESSION_ID, mode: "agent" });
});

test("sessionFork attaches to the new host session and returns a SessionDetail", async () => {
  const forked = makeRacpSession({ id: "sess-forked", title: "Forked" });
  const { backend } = makeBackend({
    "session/fork": () => ({ session: forked }),
    "session/attach": () => ({ session: forked, snapshot: makeRacpSnapshot({ session: forked }) }),
  });
  const { session } = await backend.invoke(IPC.invoke.sessionFork, [
    { sessionId: REMOTE_SESSION_ID, title: "Forked" },
  ]);
  assert.equal(session.id, makeRemoteSessionId(HOST_KEY, "sess-forked"));
  assert.equal(session.title, "Forked");
  // A SessionDetail always carries a messages array; empty is fine.
  assert.ok(Array.isArray(session.messages));
});

test("sessionRename / sessionDelete forward positional args", async () => {
  const { backend, client } = makeBackend({
    "session/rename": () => ({ ok: true }),
    "session/delete": () => ({ ok: true }),
  });
  await backend.invoke(IPC.invoke.sessionRename, [REMOTE_SESSION_ID, "New title"]);
  assert.deepEqual(client.calls[0].params, { sessionId: HOST_SESSION_ID, title: "New title" });
  await backend.invoke(IPC.invoke.sessionDelete, [REMOTE_SESSION_ID]);
  assert.deepEqual(client.calls[1].params, { sessionId: HOST_SESSION_ID });
});

test("toolResolvePermission decodes the encoded requestId back to the host approval id", async () => {
  const requestId = makeRemoteApprovalRequestId(REMOTE_SESSION_ID, "approval-77");
  const { backend, client } = makeBackend({
    "approval/respond": () => ({
      approvalId: "approval-77",
      status: "resolved",
      alreadyResolved: false,
      revision: 2,
    }),
  });
  const result = await backend.invoke(IPC.invoke.toolResolvePermission, [
    { requestId, decision: "allow-once" },
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(client.calls[0].params.approvalId, "approval-77");
  assert.equal(client.calls[0].params.decision, "allow-once");
});

test("toolResolvePermission refuses a requestId that does not name a remote session", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke(IPC.invoke.toolResolvePermission, [
      { requestId: "plain-local-request-id", decision: "deny" },
    ]),
    (error) => error.errorCode === "INTERNAL",
  );
  assert.equal(client.calls.length, 0);
});

test("askToolResolve forwards the RACP input/respond params", async () => {
  const { backend, client } = makeBackend({
    "input/respond": () => ({ ok: true }),
  });
  await backend.invoke(IPC.invoke.askToolResolve, [
    { requestId: "input-1", answers: [["yes"], null] },
  ]);
  assert.equal(client.calls[0].method, "input/respond");
  assert.deepEqual(client.calls[0].params.answers, [["yes"], null]);
  assert.equal(client.calls[0].params.inputId, "input-1");
});

test("plansResolve synthesizes the local PlanResolutionResult from the RACP result", async () => {
  const { backend, client } = makeBackend({
    "approval/respond": () => ({
      approvalId: "prop-1",
      status: "resolved",
      alreadyResolved: false,
      revision: 3,
    }),
  });
  const result = await backend.invoke(IPC.invoke.plansResolve, [
    {
      proposalId: "prop-1",
      sessionId: REMOTE_SESSION_ID,
      turnId: "turn-1",
      toolCallId: "call-1",
      action: "approve",
      targetPermissionMode: "allow",
      version: 4,
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.state, "inactive");
  assert.equal(result.action, "approve");
  assert.equal(result.targetPermissionMode, "allow");
  assert.equal(result.proposal.id, "prop-1");
  assert.equal(result.proposal.sessionId, REMOTE_SESSION_ID);
  assert.equal(result.proposal.status, "approved");
  assert.equal(result.proposal.version, 4);
  assert.equal(client.calls[0].params.permissionMode, "allow");
});

test("plansResolve on reject omits permissionMode from the RACP call", async () => {
  const { backend, client } = makeBackend({
    "approval/respond": () => ({
      approvalId: "prop-2",
      status: "resolved",
      alreadyResolved: false,
      revision: 4,
    }),
  });
  const result = await backend.invoke(IPC.invoke.plansResolve, [
    {
      proposalId: "prop-2",
      sessionId: REMOTE_SESSION_ID,
      turnId: "turn-1",
      toolCallId: "call-1",
      action: "reject",
    },
  ]);
  assert.equal(result.action, "reject");
  assert.equal(result.proposal.status, "rejected");
  assert.equal(client.calls[0].params.permissionMode, undefined);
});

test("plansPending stays empty — pending cards ride the snapshot at attach time", async () => {
  const { backend } = makeBackend();
  const result = await backend.invoke(IPC.invoke.plansPending, [{ sessionId: REMOTE_SESSION_ID }]);
  assert.deepEqual(result, { plans: [] });
});

test("an unknown channel is a bug and surfaces INTERNAL", async () => {
  const { backend } = makeBackend();
  await assert.rejects(
    backend.invoke("pi-desktop/channel/not-a-thing", [{ sessionId: REMOTE_SESSION_ID }]),
    (error) => error.errorCode === "INTERNAL",
  );
});
