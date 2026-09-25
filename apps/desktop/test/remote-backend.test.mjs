import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC, RACP_TERMINAL_INPUT_MAX_BYTES } = await import("@pi-desktop/shared");
const {
  makeRemoteApprovalRequestId,
  makeRemoteQueuedTurnId,
  makeRemoteSessionId,
  makeRemoteTerminalId,
  parseRemoteTerminalId,
} = await import("../electron/main/remote/backend-router.ts");
const { REMOTE_SESSION_CAPABILITIES, remoteSessionSummary, snapshotToSessionDetail } = await import(
  "../electron/main/remote/remote-transcript.ts"
);
const { HANDLED_CHANNELS, createRemoteBackend } = await import(
  "../electron/main/remote/remote-backend.ts"
);

const HOST_KEY = "hostA";
const HOST_SESSION_ID = "sess-1";
const REMOTE_SESSION_ID = makeRemoteSessionId(HOST_KEY, HOST_SESSION_ID);
const HOST = { hostKey: HOST_KEY, hostLabel: "Host A" };

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
    hostLabel: HOST.hostLabel,
    client,
    // A deterministic id keeps the recorded request context stable in assertions.
    newRequestId: () => "req-const",
    ...extra,
  });
  return { backend, client };
}

test("remoteSessionSummary maps the host-agnostic renderer summary", () => {
  const session = makeRacpSession({ mode: "agent", permissionMode: "allow", workspaceLabel: "repo" });
  const summary = remoteSessionSummary(REMOTE_SESSION_ID, session, HOST, 7);
  assert.deepEqual(summary.capabilities, { ...REMOTE_SESSION_CAPABILITIES });
  assert.deepEqual(summary.remote, { hostKey: HOST_KEY, hostLabel: "Host A", workspaceLabel: "repo" });
  // An unobserved count defaults to "not known to be empty".
  assert.equal(remoteSessionSummary(REMOTE_SESSION_ID, makeRacpSession(), HOST).messageCount, 1);
  assert.deepEqual(remoteSessionSummary(REMOTE_SESSION_ID, makeRacpSession(), HOST).remote, {
    hostKey: HOST_KEY,
    hostLabel: "Host A",
  });
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
  const detail = snapshotToSessionDetail(REMOTE_SESSION_ID, snapshot, HOST);
  assert.equal(detail.source, "remote");
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
    IPC.invoke.agentQueueRemove,
    IPC.invoke.agentQueuePrioritize,
    IPC.invoke.agentStop,
    IPC.invoke.agentAbort,
    IPC.invoke.agentCompact,
    IPC.invoke.agentGetStatus,
    IPC.invoke.sessionGet,
    IPC.invoke.sessionConfigure,
    IPC.invoke.sessionFork,
    IPC.invoke.sessionRename,
    IPC.invoke.sessionDelete,
    IPC.invoke.toolResolvePermission,
    IPC.invoke.askToolResolve,
    IPC.invoke.plansResolve,
    IPC.invoke.plansPending,
    IPC.invoke.fsList,
    IPC.invoke.fsRead,
    IPC.invoke.fsResolveRef,
    IPC.invoke.workspaceDiff,
    IPC.invoke.remoteTerminalOpen,
    IPC.invoke.remoteTerminalInput,
    IPC.invoke.remoteTerminalResize,
    IPC.invoke.remoteTerminalClose,
  ];
  for (const channel of covered) assert.ok(backend.handles(channel), `${channel} should be handled`);
  assert.deepEqual([...HANDLED_CHANNELS].sort(), [...covered].sort());
  // Steering has no RACP operation; it fails closed in the router.
  assert.equal(backend.handles(IPC.invoke.agentSteer), false);
  // Unrelated desktop channels are not served remotely.
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

test("workspaceDiff reads the requested remote session root", async () => {
  const diff = { repo: true, clean: false, files: [{ path: "src/a.ts", status: "modified" }] };
  const { backend, client } = makeBackend({ "workspace/diff": () => diff });
  assert.deepEqual(
    await backend.invoke(IPC.invoke.workspaceDiff, [{ sessionId: REMOTE_SESSION_ID }]),
    diff,
  );
  assert.deepEqual(client.calls, [
    { method: "workspace/diff", params: { sessionId: HOST_SESSION_ID } },
  ]);
});

test("remote terminal open and control calls map to the owning RACP session", async () => {
  const opened = { terminalId: "host-terminal-1", replay: "aGk=", cols: 100, rows: 30 };
  const { backend, client } = makeBackend({
    "terminal/open": opened,
    "terminal/input": { ok: true },
    "terminal/resize": { ok: true },
    "terminal/close": { ok: true },
  });
  const result = await backend.invoke(IPC.invoke.remoteTerminalOpen, [{
    sessionId: REMOTE_SESSION_ID,
    cols: 100,
    rows: 30,
    openRequestId: "open-1",
  }]);
  assert.deepEqual(result, {
    ...opened,
    terminalId: makeRemoteTerminalId(REMOTE_SESSION_ID, "host-terminal-1"),
  });
  const terminalId = result.terminalId;
  await backend.invoke(IPC.invoke.remoteTerminalInput, [{
    sessionId: REMOTE_SESSION_ID,
    terminalId,
    data: "cHdkDQo=",
  }]);
  await backend.invoke(IPC.invoke.remoteTerminalResize, [{
    sessionId: REMOTE_SESSION_ID,
    terminalId,
    cols: 120,
    rows: 40,
  }]);
  await backend.invoke(IPC.invoke.remoteTerminalClose, [{ sessionId: REMOTE_SESSION_ID, terminalId }]);
  assert.deepEqual(client.calls, [
    { method: "terminal/open", params: { sessionId: HOST_SESSION_ID, cols: 100, rows: 30, openRequestId: "open-1" } },
    { method: "terminal/input", params: { terminalId: "host-terminal-1", data: "cHdkDQo=" } },
    { method: "terminal/resize", params: { terminalId: "host-terminal-1", cols: 120, rows: 40 } },
    { method: "terminal/close", params: { terminalId: "host-terminal-1" } },
  ]);
  assert.deepEqual(parseRemoteTerminalId(terminalId), {
    remoteSessionId: REMOTE_SESSION_ID,
    hostTerminalId: "host-terminal-1",
  });
});

test("remote terminal controls reject a terminal scoped to another session", async () => {
  const { backend, client } = makeBackend({ "terminal/input": { ok: true } });
  await assert.rejects(
    backend.invoke(IPC.invoke.remoteTerminalInput, [{
      sessionId: REMOTE_SESSION_ID,
      terminalId: makeRemoteTerminalId(makeRemoteSessionId(HOST_KEY, "other-session"), "host-terminal-1"),
      data: "x",
    }]),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  assert.equal(client.calls.length, 0);
});

test("remote terminal open re-attaches with the namespaced id's host terminal", async () => {
  const { backend, client } = makeBackend({
    "terminal/open": { terminalId: "host-terminal-2", replay: "", cols: 80, rows: 24 },
  });
  const terminalId = makeRemoteTerminalId(REMOTE_SESSION_ID, "host-terminal-2");
  await backend.invoke(IPC.invoke.remoteTerminalOpen, [{ sessionId: REMOTE_SESSION_ID, terminalId }]);
  assert.deepEqual(client.calls, [
    { method: "terminal/open", params: { sessionId: HOST_SESSION_ID, terminalId: "host-terminal-2" } },
  ]);
});

test("remote terminal open rejects invalid dimensions before contacting the Host", async () => {
  const { backend, client } = makeBackend({});
  await assert.rejects(
    backend.invoke(IPC.invoke.remoteTerminalOpen, [{ sessionId: REMOTE_SESSION_ID, cols: 0 }]),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  assert.equal(client.calls.length, 0);
});

test("remote terminal input rejects non-base64 data before contacting the Host", async () => {
  const { backend, client } = makeBackend({ "terminal/input": { ok: true } });
  for (const data of ["not-base64?", "YR==", "/w=="]) {
    await assert.rejects(
      backend.invoke(IPC.invoke.remoteTerminalInput, [{
        sessionId: REMOTE_SESSION_ID,
        terminalId: makeRemoteTerminalId(REMOTE_SESSION_ID, "host-terminal-1"),
        data,
      }]),
      (error) => error.errorCode === "INVALID_ARGUMENT",
    );
  }
  const oversized = Buffer.alloc(RACP_TERMINAL_INPUT_MAX_BYTES + 1).toString("base64");
  await assert.rejects(
    backend.invoke(IPC.invoke.remoteTerminalInput, [{
      sessionId: REMOTE_SESSION_ID,
      terminalId: makeRemoteTerminalId(REMOTE_SESSION_ID, "host-terminal-1"),
      data: oversized,
    }]),
    (error) => error.errorCode === "PAYLOAD_TOO_LARGE",
  );
  assert.equal(client.calls.length, 0);
});

test("remote terminal RACP errors preserve their error code", async () => {
  const { backend, client } = makeBackend({
    "terminal/input": () => {
      throw Object.assign(new Error("owner device required"), { errorCode: "FORBIDDEN" });
    },
  });
  await assert.rejects(
    backend.invoke(IPC.invoke.remoteTerminalInput, [{
      sessionId: REMOTE_SESSION_ID,
      terminalId: makeRemoteTerminalId(REMOTE_SESSION_ID, "host-terminal-1"),
      data: "eA==",
    }]),
    (error) => error.errorCode === "FORBIDDEN" && error.message === "owner device required",
  );
  assert.equal(client.calls.length, 1);
});

test("agentQueuePush queues with the local content, since RACP turns carry none", async () => {
  const turn = makeRacpTurn({ id: "turn-q", admission: "queue", queuePosition: 2 });
  const { backend, client } = makeBackend({
    "turn/start": () => ({ accepted: true, turn }),
  });
  const result = await backend.invoke(IPC.invoke.agentQueuePush, [
    { sessionId: REMOTE_SESSION_ID, content: "pushed prompt", idempotencyKey: "k1" },
  ]);
  assert.equal(result.id, makeRemoteQueuedTurnId(REMOTE_SESSION_ID, "turn-q"));
  assert.equal(result.sessionId, REMOTE_SESSION_ID);
  assert.equal(result.content, "pushed prompt");
  assert.equal(result.position, 2);
  assert.equal(client.calls[0].params.admission, "queue");
  assert.equal(client.calls[0].params.idempotencyKey, "k1");
});

test("agentQueueList reads queuedTurnIds and keeps text only for turns this desktop pushed", async () => {
  const { backend } = makeBackend({
    "turn/start": () => ({ accepted: true, turn: makeRacpTurn({ id: "q2", admission: "queue" }) }),
    "session/get": () => ({
      session: makeRacpSession({ queuedTurnIds: ["q1", "q2"], updatedAt: "2026-09-18T11:00:00.000Z" }),
    }),
  });
  await backend.invoke(IPC.invoke.agentQueuePush, [
    { sessionId: REMOTE_SESSION_ID, content: "mine" },
  ]);
  const result = await backend.invoke(IPC.invoke.agentQueueList, [
    { sessionId: REMOTE_SESSION_ID },
  ]);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].id, makeRemoteQueuedTurnId(REMOTE_SESSION_ID, "q1"));
  assert.equal(result.entries[0].sessionId, REMOTE_SESSION_ID);
  // A turn queued by another client carries no text this desktop knows.
  assert.equal(result.entries[0].content, "");
  assert.equal(result.entries[0].createdAt, "2026-09-18T11:00:00.000Z");
  assert.equal(result.entries[0].position, 1);
  assert.equal(result.entries[1].content, "mine");
  assert.equal(result.entries[1].position, 2);
});

test("agentQueueRemove / agentQueuePrioritize decode the encoded turn id", async () => {
  const { backend, client } = makeBackend({
    "turn/cancel": () => ({ ok: true }),
    "turn/prioritize": () => ({ ok: true }),
  });
  const turnId = makeRemoteQueuedTurnId(REMOTE_SESSION_ID, "host-turn-3");
  assert.deepEqual(await backend.invoke(IPC.invoke.agentQueueRemove, [{ turnId }]), { ok: true });
  assert.deepEqual(await backend.invoke(IPC.invoke.agentQueuePrioritize, [{ turnId }]), { ok: true });
  assert.deepEqual(client.calls, [
    { method: "turn/cancel", params: { turnId: "host-turn-3" } },
    { method: "turn/prioritize", params: { turnId: "host-turn-3" } },
  ]);
});

test("agentQueueRemove refuses a plain turn id without any RACP call", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke(IPC.invoke.agentQueueRemove, [{ turnId: "host-turn-3" }]),
    (error) => error.errorCode === "INTERNAL",
  );
  assert.equal(client.calls.length, 0);
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
  // Awaiting a decision is still an in-flight turn.
  assert.equal(status.isRunning, true);
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

test("an unknown channel fails closed with CAPABILITY_UNAVAILABLE", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke("pi-desktop/channel/not-a-thing", [{ sessionId: REMOTE_SESSION_ID }]),
    (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(client.calls.length, 0);
});

test("a call addressing another host's session is refused as INTERNAL", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke(IPC.invoke.agentCompact, [{ sessionId: makeRemoteSessionId("hostB", "s") }]),
    (error) => error.errorCode === "INTERNAL",
  );
  assert.equal(client.calls.length, 0);
});

test("fsList / fsRead route to workspace/list and workspace/read; fsResolveRef never matches", async () => {
  const { backend, client } = makeBackend({
    "workspace/list": () => ({ entries: [{ name: "a.ts" }] }),
    "workspace/read": () => ({ content: "x" }),
  });
  assert.deepEqual(
    await backend.invoke(IPC.invoke.fsList, [{ sessionId: REMOTE_SESSION_ID, path: "src" }]),
    { entries: [{ name: "a.ts" }] },
  );
  await backend.invoke(IPC.invoke.fsList, [{ sessionId: REMOTE_SESSION_ID }]);
  assert.deepEqual(
    await backend.invoke(IPC.invoke.fsRead, [{ sessionId: REMOTE_SESSION_ID, path: "src/a.ts" }]),
    { content: "x" },
  );
  assert.deepEqual(client.calls, [
    { method: "workspace/list", params: { sessionId: HOST_SESSION_ID, path: "src" } },
    { method: "workspace/list", params: { sessionId: HOST_SESSION_ID } },
    { method: "workspace/read", params: { sessionId: HOST_SESSION_ID, path: "src/a.ts" } },
  ]);
  await assert.rejects(
    backend.invoke(IPC.invoke.fsRead, [{ sessionId: REMOTE_SESSION_ID }]),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  assert.deepEqual(
    await backend.invoke(IPC.invoke.fsResolveRef, [{ sessionId: REMOTE_SESSION_ID, ref: "a.ts" }]),
    { match: null },
  );
  assert.equal(client.calls.length, 3);
});

test("sessionGet with messageAround is refused without any RACP call", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke(IPC.invoke.sessionGet, [{ id: REMOTE_SESSION_ID, messageAround: "m1" }]),
    (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(client.calls.length, 0);
});

test("sessionGet tail read reports the attach cursor through onSessionRead", async () => {
  const reads = [];
  const { backend } = makeBackend(
    {
      "session/attach": () => ({
        session: makeRacpSession(),
        snapshot: makeRacpSnapshot({ cursor: { epoch: "e", sequence: 7 } }),
      }),
    },
    { onSessionRead: (id, cursor) => reads.push([id, cursor]) },
  );
  await backend.invoke(IPC.invoke.sessionGet, [{ id: REMOTE_SESSION_ID, messageLimit: 10 }]);
  assert.deepEqual(reads, [[HOST_SESSION_ID, { epoch: "e", sequence: 7 }]]);
});

test("agentQueuePush with attachments raises CAPABILITY_UNAVAILABLE without any RACP call", async () => {
  const { backend, client } = makeBackend();
  await assert.rejects(
    backend.invoke(IPC.invoke.agentQueuePush, [
      { sessionId: REMOTE_SESSION_ID, content: "hi", attachments: [{ id: "a" }] },
    ]),
    (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(client.calls.length, 0);
});

test("sessionConfigure strips provider/model/thinking and the desktop-only inherit literal", async () => {
  const noticed = [];
  const { backend, client } = makeBackend(
    { "session/configure": () => ({ session: makeRacpSession({ mode: "plan" }) }) },
    { onSession: (session) => noticed.push(session.id) },
  );
  const { session } = await backend.invoke(IPC.invoke.sessionConfigure, [
    REMOTE_SESSION_ID,
    { providerId: "p", modelId: "m", thinkingLevel: "high", mode: "plan", permissionMode: "inherit" },
  ]);
  assert.deepEqual(client.calls[0].params, { sessionId: HOST_SESSION_ID, mode: "plan" });
  await backend.invoke(IPC.invoke.sessionConfigure, [
    REMOTE_SESSION_ID,
    { mode: "inherit", permissionMode: "auto" },
  ]);
  assert.deepEqual(client.calls[1].params, { sessionId: HOST_SESSION_ID, permissionMode: "auto" });
  assert.equal(session.id, REMOTE_SESSION_ID);
  assert.equal(session.source, "remote");
  assert.deepEqual(noticed, [HOST_SESSION_ID, HOST_SESSION_ID]);
});
