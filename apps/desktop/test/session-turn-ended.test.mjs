import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// The real coordination state and the real persistence pass, driven directly.
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);
const { createEventPersistence } = await import(
  "../electron/main/runtime/event-persistence.ts"
);

const SESSION = "s1";
const LIVE_TURN = "turn-b";
const OLD_TURN = "turn-a";

function fixture() {
  const activeTurns = new Map([[SESSION, LIVE_TURN]]);
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  const finished = [];
  const emitted = [];
  const enqueued = [];

  const persistence = createEventPersistence({
    runtimeState: { host: null },
    activeTurns,
    activeToolCalls: new Map(),
    activeToolCallKey: coordination.activeToolCallKey,
    approvedExecutionIdsBySession: new Map(),
    approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(),
    planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: { observe() {}, flush: async () => {}, settle() {}, settleIf() {} },
    persistenceOutbox: {
      size: () => 0,
      enqueue: async (entry) => {
        enqueued.push(entry);
      },
      flush: async () => undefined,
    },
    addActiveTurnUsage() {},
    logger: { app() {} },
    finishTurn: (sessionId, status, errorCode, options) => {
      finished.push({ sessionId, status, errorCode, turnId: options.turnId });
      return Promise.resolve();
    },
    isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    finishApprovedExecution: async () => undefined,
    emitAgentEvent: (envelope) => emitted.push(envelope),
  });

  const envelope = (event, turnId, extra = {}) => ({
    sessionId: SESSION,
    ...(turnId === undefined ? {} : { turnId }),
    ts: 1,
    event,
    ...extra,
  });

  return {
    activeTurns,
    coordination,
    persistence,
    finished,
    emitted,
    enqueued,
    envelope,
  };
}

const agentEnd = { type: "agent_end", messageIds: [] };

test("agent_end carrying the live turn identity finishes that turn", () => {
  const f = fixture();
  f.persistence.persistAgentEvent(f.envelope(agentEnd, LIVE_TURN));
  assert.deepEqual(f.finished, [
    { sessionId: SESSION, status: "completed", errorCode: undefined, turnId: LIVE_TURN },
  ]);
});

test("agent_end naming a turn that no longer owns the session is refused", () => {
  const f = fixture();
  f.persistence.persistAgentEvent(f.envelope(agentEnd, OLD_TURN));
  assert.deepEqual(f.finished, [], "a late turn must not settle the live one");
  assert.deepEqual(f.emitted, [], "nor restate the regenerate branch archive");
});

test("agent_end carrying no turn identity is refused", () => {
  const f = fixture();
  f.persistence.persistAgentEvent(f.envelope(agentEnd, undefined));
  assert.deepEqual(f.finished, []);
});

test("an error for a stale turn does not settle the live turn", () => {
  const f = fixture();
  const failure = {
    type: "error",
    error: { code: "TURN_ABORTED", message: "cancelled", retriable: false },
  };
  f.persistence.persistAgentEvent(f.envelope(failure, OLD_TURN));
  f.persistence.persistAgentEvent(f.envelope(failure, undefined));
  assert.deepEqual(f.finished, []);
});

test("a terminal event for a delegate never ends the parent's turn", () => {
  const f = fixture();
  f.persistence.persistAgentEvent(
    f.envelope(agentEnd, LIVE_TURN, { parentToolCallId: "call-1" }),
  );
  assert.deepEqual(f.finished, []);
});

test("non-terminal rows of a late turn are still archived as history", async () => {
  const f = fixture();
  const result = f.persistence.persistAgentEvent(
    f.envelope(
      { type: "tool_end", toolCallId: "call-old", result: "done", isError: false },
      OLD_TURN,
    ),
  );
  assert.equal(result?.id, "call-old", "the completed row is still returned");
  await Promise.resolve();
  assert.equal(f.enqueued.length, 1, "and still enqueued for persistence");
  assert.equal(f.enqueued[0].turnId, OLD_TURN, "archived under its own turn");
  assert.deepEqual(f.finished, [], "while the live turn is untouched");
});

test("isStaleTerminalEvent only classifies terminal events", () => {
  const f = fixture();
  const stale = {
    sessionId: SESSION,
    turnId: OLD_TURN,
    ts: 1,
    event: agentEnd,
  };
  assert.equal(f.coordination.isStaleTerminalEvent(stale), true);
  assert.equal(
    f.coordination.isStaleTerminalEvent({ ...stale, turnId: LIVE_TURN }),
    false,
  );
  assert.equal(
    f.coordination.isStaleTerminalEvent({ ...stale, turnId: undefined }),
    true,
  );
  for (const event of [
    { type: "message_update", message: { id: "m", role: "assistant" } },
    { type: "tool_start", toolCallId: "c", toolName: "X", args: {} },
  ]) {
    assert.equal(
      f.coordination.isStaleTerminalEvent({ ...stale, event }),
      false,
      `${event.type} is not terminal`,
    );
  }
});

test("a dispatched plugin tool is refused once the turn is cancelled or finalizing", () => {
  const f = fixture();
  assert.equal(f.coordination.isTurnDispatchable(SESSION, LIVE_TURN), true);

  // Cancelled: a plugin side effect must not start while the cancel is in flight.
  f.coordination.lockAbortReason(SESSION, LIVE_TURN);
  assert.equal(f.coordination.isTurnDispatchable(SESSION, LIVE_TURN), false);
  f.coordination.clearAbortReason(SESSION, LIVE_TURN);
  assert.equal(f.coordination.isTurnDispatchable(SESSION, LIVE_TURN), true);

  // Finalizing: the turn can no longer start one.
  f.coordination.turnFinalizations.set(`${SESSION}:${LIVE_TURN}`, Promise.resolve());
  assert.equal(f.coordination.isTurnDispatchable(SESSION, LIVE_TURN), false);

  // A turn this session never owned, or no identity at all, is refused too.
  assert.equal(f.coordination.isTurnDispatchable(SESSION, OLD_TURN), false);
  assert.equal(f.coordination.isTurnDispatchable(SESSION, undefined), false);
});

test("the queue stays busy while a turn's finalization record is held", () => {
  const f = fixture();
  assert.equal(f.coordination.isSessionBusy(SESSION), true, "live turn");

  const record = Promise.resolve();
  f.activeTurns.delete(SESSION);
  assert.equal(
    f.coordination.isSessionBusy(SESSION),
    false,
    "released ownership alone is not busy",
  );
  f.coordination.turnFinalizations.set(`${SESSION}:${LIVE_TURN}`, record);
  assert.equal(
    f.coordination.isSessionBusy(SESSION),
    true,
    "the announcement window still holds the queue",
  );
  f.coordination.turnFinalizations.delete(`${SESSION}:${LIVE_TURN}`);
  assert.equal(f.coordination.isSessionBusy(SESSION), false);
  assert.equal(f.coordination.isSessionBusy("other-session"), false);
});

test("a cancellation lock is scoped to its own turn and never inferred", () => {
  const f = fixture();
  // A session with no live turn keeps its existing cancel behaviour but locks
  // nothing, so a later event cannot be attributed to a turn that never ran.
  f.coordination.lockAbortReason("no-turn-session", "some-turn");
  assert.equal(
    f.coordination.peekAbortReason("no-turn-session", "some-turn"),
    undefined,
  );
  // Another turn's lock must not be visible, and reading never consumes it.
  f.coordination.lockAbortReason(SESSION, LIVE_TURN);
  assert.equal(f.coordination.peekAbortReason(SESSION, OLD_TURN), undefined);
  assert.equal(f.coordination.peekAbortReason(SESSION, LIVE_TURN), "aborted");
  assert.equal(f.coordination.peekAbortReason(SESSION, LIVE_TURN), "aborted");
  f.coordination.clearAbortReason(SESSION, LIVE_TURN);
  assert.equal(f.coordination.peekAbortReason(SESSION, LIVE_TURN), undefined);
});
