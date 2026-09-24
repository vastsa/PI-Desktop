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
const { createRemoteEventBridge } = await import(
  "../electron/main/remote/remote-event-bridge.ts"
);

const HOST_KEY = "hostA";
const HOST_SESSION_ID = "sess-1";
const REMOTE_SESSION_ID = makeRemoteSessionId(HOST_KEY, HOST_SESSION_ID);

function makeEnvelope(overrides = {}) {
  return {
    eventId: "e1",
    scope: "session",
    sessionId: HOST_SESSION_ID,
    epoch: "epoch-1",
    revision: 1,
    kind: "item.started",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function collect() {
  const events = [];
  const lifecycle = [];
  const warnings = [];
  const bridge = createRemoteEventBridge({
    hostKey: HOST_KEY,
    emit: (channel, payload) => events.push({ channel, payload }),
    onLifecycle: (event) => lifecycle.push(event),
    log: (level, message, data) => warnings.push({ level, message, data }),
  });
  return { bridge, events, lifecycle, warnings };
}

test("host-scope status-only session.changed still produces a lifecycle event", () => {
  const { bridge, events, lifecycle } = collect();
  bridge.handle(
    makeEnvelope({
      scope: "host",
      kind: "session.changed",
      payload: { sessionId: HOST_SESSION_ID, status: "running", planningState: "inactive" },
    }),
  );
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].kind, "session.changed");
  assert.equal(lifecycle[0].hostSessionId, HOST_SESSION_ID);
  assert.equal(lifecycle[0].remoteSessionId, REMOTE_SESSION_ID);
  assert.equal(lifecycle[0].session.id, HOST_SESSION_ID);
  assert.equal(lifecycle[0].session.status, "running");
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, IPC.event.sessionsChanged);
  assert.equal(events[0].payload.reason, "remote.session.changed");
  assert.equal(events[0].payload.selectSessionId, undefined);
});

test("host-scope session.created fires lifecycle and refreshes sessions without stealing focus", () => {
  const { bridge, events, lifecycle } = collect();
  bridge.handle(
    makeEnvelope({
      scope: "host",
      kind: "session.created",
      payload: {
        session: {
          id: HOST_SESSION_ID,
          title: "Fresh remote",
          createdAt: "2026-09-18T10:00:00.000Z",
          updatedAt: "2026-09-18T10:00:00.000Z",
        },
      },
    }),
  );
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].kind, "session.created");
  assert.equal(lifecycle[0].remoteSessionId, REMOTE_SESSION_ID);
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, IPC.event.sessionsChanged);
  assert.equal(events[0].payload.reason, "remote.session.created");
  // A session another client created must not take this window's focus.
  assert.equal("selectSessionId" in events[0].payload, false);
});

test("host-scope session.archived tells the router to release the id without selecting it", () => {
  const { bridge, events, lifecycle } = collect();
  bridge.handle(
    makeEnvelope({
      scope: "host",
      kind: "session.archived",
      payload: { session: { id: HOST_SESSION_ID } },
    }),
  );
  assert.equal(lifecycle[0].kind, "session.archived");
  assert.equal(events[0].payload.reason, "remote.session.archived");
  assert.equal(events[0].payload.selectSessionId, undefined);
});

test("host-scope events without a session payload log a warning and no emit fires", () => {
  const { bridge, events, warnings } = collect();
  bridge.handle(
    makeEnvelope({ scope: "host", kind: "session.changed", payload: {} }),
  );
  assert.equal(events.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /carried no session/);
});

test("item.started forwards the AgentEvent verbatim under the remote session id", () => {
  const { bridge, events } = collect();
  const agentEvent = { type: "tool_start", toolCallId: "tc-1", toolName: "shell", args: {} };
  bridge.handle(
    makeEnvelope({
      kind: "item.started",
      turnId: "turn-1",
      payload: { itemType: "tool", itemId: "i-1", event: agentEvent },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, IPC.event.agentMessage);
  assert.equal(events[0].payload.sessionId, REMOTE_SESSION_ID);
  assert.equal(events[0].payload.turnId, "turn-1");
  assert.deepEqual(events[0].payload.event, agentEvent);
  assert.equal(events[0].payload.ts, Date.parse("2026-09-18T10:00:00.000Z"));
});

test("session.changed forwards a PlanningStateEvent as a local planning_state AgentEvent", () => {
  const { bridge, events } = collect();
  bridge.handle(
    makeEnvelope({
      kind: "session.changed",
      payload: {
        event: {
          sessionId: HOST_SESSION_ID,
          state: "awaiting_approval",
          kind: "plan",
          proposalId: "p-1",
          title: "Do a thing",
        },
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, IPC.event.agentMessage);
  const forwarded = events[0].payload.event;
  assert.equal(forwarded.type, "planning_state");
  assert.equal(forwarded.state, "awaiting_approval");
  assert.equal(forwarded.proposalId, "p-1");
  // The host session id is stripped — the AgentEventEnvelope carries the
  // (remote) session id already.
  assert.equal(forwarded.sessionId, undefined);
});

test("session.changed status-only payloads are dropped", () => {
  const { bridge, events } = collect();
  bridge.handle(
    makeEnvelope({
      kind: "session.changed",
      payload: { sessionId: HOST_SESSION_ID, status: "idle", planningState: "inactive" },
    }),
  );
  assert.equal(events.length, 0);
});

test("approval.requested kind:tool synthesizes a local tool_permission_request with an encoded requestId", () => {
  const { bridge, events } = collect();
  const approval = {
    id: "appr-9",
    sessionId: HOST_SESSION_ID,
    turnId: "turn-1",
    kind: "tool",
    summary: "run rm -rf",
    expiresAt: "2026-09-18T10:05:00.000Z",
    revision: 3,
    toolName: "shell",
    risk: "high",
    allowedDecisions: ["allow-once", "deny"],
  };
  bridge.handle(
    makeEnvelope({ kind: "approval.requested", turnId: "turn-1", payload: approval }),
  );
  assert.equal(events.length, 1);
  const request = events[0].payload.event.request;
  assert.equal(events[0].payload.event.type, "tool_permission_request");
  assert.equal(request.requestId, makeRemoteApprovalRequestId(REMOTE_SESSION_ID, "appr-9"));
  assert.equal(request.sessionId, REMOTE_SESSION_ID);
  assert.equal(request.toolName, "shell");
  assert.equal(request.risk, "high");
  assert.equal(request.reason, "run rm -rf");
});

test("approval.requested kind:plan and kind:goal are dropped — the plan card rides planning_state", () => {
  const { bridge, events } = collect();
  const base = {
    sessionId: HOST_SESSION_ID,
    turnId: "turn-1",
    summary: "approve plan",
    expiresAt: "2026-09-18T10:05:00.000Z",
    revision: 3,
    allowedDecisions: ["approve", "reject"],
    allowedPermissionModes: ["default"],
  };
  bridge.handle(makeEnvelope({ kind: "approval.requested", payload: { ...base, id: "p-1", kind: "plan" } }));
  bridge.handle(makeEnvelope({ kind: "approval.requested", payload: { ...base, id: "g-1", kind: "goal" } }));
  assert.equal(events.length, 0);
});

test("input.requested synthesizes an asktool_request keyed by the RACP input id", () => {
  const { bridge, events } = collect();
  bridge.handle(
    makeEnvelope({
      kind: "input.requested",
      payload: {
        id: "input-42",
        sessionId: HOST_SESSION_ID,
        turnId: "turn-1",
        expiresAt: "2026-09-18T10:05:00.000Z",
        agentName: "codex",
        parentToolCallId: "tc-parent",
        questions: [
          { id: "q1", question: "which?", options: ["a", "b"], multiSelect: false },
        ],
      },
    }),
  );
  const request = events[0].payload.event.request;
  assert.equal(events[0].payload.event.type, "asktool_request");
  assert.equal(request.requestId, "input-42");
  assert.equal(request.sessionId, REMOTE_SESSION_ID);
  assert.equal(request.toolCallId, "tc-parent");
  assert.equal(request.questions.length, 1);
  assert.equal(request.questions[0].multiSelect, false);
});

test("terminal and resync kinds are silently dropped in Stage 2 — later stages own them", () => {
  const { bridge, events } = collect();
  bridge.handle(makeEnvelope({ kind: "terminal.output", payload: {} }));
  bridge.handle(makeEnvelope({ kind: "terminal.changed", payload: {} }));
  bridge.handle(makeEnvelope({ kind: "resync.required", payload: {} }));
  bridge.handle(makeEnvelope({ kind: "approval.resolved", payload: {} }));
  bridge.handle(makeEnvelope({ kind: "input.resolved", payload: {} }));
  assert.equal(events.length, 0);
});

test("host.changed does not emit — the desktop has no host status surface yet", () => {
  const { bridge, events, lifecycle } = collect();
  bridge.handle(
    makeEnvelope({ scope: "host", kind: "host.changed", payload: { host: { id: "h" } } }),
  );
  assert.equal(events.length, 0);
  assert.equal(lifecycle.length, 0);
});

test("an unknown kind stays quiet — the bridge never throws on unfamiliar events", () => {
  const { bridge, events, warnings } = collect();
  bridge.handle(makeEnvelope({ kind: "made.up.kind", payload: {} }));
  assert.equal(events.length, 0);
  assert.equal(warnings.length, 0);
});
