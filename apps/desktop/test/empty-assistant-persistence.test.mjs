import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// The real persistence pass, driven directly with a stubbed outbox.
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);
const { createEventPersistence } = await import(
  "../electron/main/runtime/event-persistence.ts"
);

const SESSION = "s1";
const TURN = "turn-1";

function fixture() {
  const activeTurns = new Map([[SESSION, TURN]]);
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  coordination.recordTurnStart(SESSION, TURN);
  const enqueued = [];
  const steeringReplies = new Set();
  const completionNoticeTurns = new Set();
  const persistence = createEventPersistence({
    runtimeState: { host: null },
    steeringReplies,
    completionNoticeTurns,
    activeTurns,
    activeToolCalls: new Map(),
    activeToolCallKey: coordination.activeToolCallKey,
    approvedExecutionIdsBySession: new Map(),
    approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(),
    planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: {
      observe() {},
      flush: async () => {},
      settle() {},
      settleIf() {},
    },
    persistenceOutbox: {
      size: () => 0,
      enqueue: async (entry) => {
        enqueued.push(entry);
      },
      flush: async () => undefined,
    },
    addActiveTurnUsage() {},
    logger: { app() {} },
    finishTurn: () => Promise.resolve(),
    isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    transcriptRewrite: coordination,
    finishApprovedExecution: async () => undefined,
    emitAgentEvent() {},
  });
  const persistAssistant = (message) =>
    persistence.persistAgentEvent({
      sessionId: SESSION,
      turnId: TURN,
      ts: 1,
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          createdAt: "2026-10-20T00:00:00.000Z",
          ...message,
        },
      },
    });
  const persistSteering = () =>
    persistence.persistAgentEvent({
      sessionId: SESSION,
      turnId: TURN,
      ts: 1,
      event: {
        type: "message_end",
        message: {
          id: "steer-1",
          role: "user",
          content: "continue",
          createdAt: "2026-10-20T00:00:00.000Z",
          status: "complete",
          steering: true,
        },
      },
    });
  const persistAgentEnd = () =>
    persistence.persistAgentEvent({
      sessionId: SESSION,
      turnId: TURN,
      ts: 1,
      event: { type: "agent_end", messageIds: [] },
    });
  return { activeTurns, coordination, enqueued, steeringReplies, completionNoticeTurns, persistAssistant, persistSteering, persistAgentEnd };
}

test("an empty complete assistant message is not persisted", () => {
  const f = fixture();
  f.persistAssistant({ id: "m1", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 0);
});

test("an empty aborted assistant message without an error is not persisted", () => {
  const f = fixture();
  f.persistAssistant({ id: "m2", content: "", thinking: "", status: "aborted" });
  assert.equal(f.enqueued.length, 0);
});

test("an empty assistant message that still carries a tool row is persisted", () => {
  const f = fixture();
  f.persistAssistant({
    id: "m3",
    content: "",
    thinking: "",
    status: "complete",
    toolName: "Grep",
    toolCallId: "call-1",
    toolStatus: "success",
  });
  assert.equal(f.enqueued.length, 1);
});

test("an empty call-only reply with provider replay data is persisted (#1972)", () => {
  // Gemini signs a function call on its own; a rebuilt runtime can only send
  // that signature back if the reply row that carries it is durable.
  const f = fixture();
  f.persistAssistant({
    id: "m3-signed",
    content: "",
    thinking: "",
    status: "complete",
    providerReplay: { version: 1, blocks: [], toolCalls: [{ id: "call-1", signature: "sig" }] },
  });
  assert.equal(f.enqueued.length, 1);
  assert.deepEqual(f.enqueued[0].message.providerReplay.toolCalls, [{ id: "call-1", signature: "sig" }]);
});

test("an empty assistant message with an error payload stays durable", () => {
  const f = fixture();
  f.persistAssistant({
    id: "m4",
    content: "",
    thinking: "",
    status: "error",
    error: { code: "PROVIDER_ERROR", message: "boom" },
  });
  assert.equal(f.enqueued.length, 1);
});

test("an empty assistant message reserved for steering is persisted", () => {
  const f = fixture();
  f.steeringReplies.add("m5");
  f.persistAssistant({ id: "m5", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});

test("a trusted completion notice persists only its first empty complete reply", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistAssistant({ id: "completion-1", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.completionNoticeTurns.has(TURN), false);

  f.persistAssistant({ id: "completion-2", content: "", thinking: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});

test("a visible or tool-batch completion reply spends the empty-row exception", () => {
  for (const reply of [
    { id: "visible", content: "done", status: "complete" },
    { id: "tool", content: "", status: "complete", toolName: "Read", toolCallId: "call-1" },
  ]) {
    const f = fixture();
    f.completionNoticeTurns.add(TURN);
    f.persistAssistant(reply);
    f.persistAssistant({ id: `${reply.id}-empty`, content: "", status: "complete" });
    assert.equal(f.enqueued.length, 1);
    assert.equal(f.completionNoticeTurns.has(TURN), false);
  }
});

test("provider error retries keep the completion notice allowance", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistAssistant({
    id: "retry-error",
    content: "",
    status: "error",
    error: { code: "PROVIDER_ERROR", message: "retry" },
  });
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.completionNoticeTurns.has(TURN), true);

  f.persistAssistant({ id: "retry-complete", content: "", status: "complete" });
  assert.equal(f.enqueued.length, 2);
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});

test("accepted user steering revokes the completion notice allowance", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistSteering();
  assert.equal(f.completionNoticeTurns.has(TURN), false);

  f.persistAssistant({ id: "after-steering", content: "", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});

test("turn settlement clears an unused completion notice allowance", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.persistAgentEnd();
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});

test("a stale turn cannot leave an unused completion notice allowance behind", () => {
  const f = fixture();
  f.completionNoticeTurns.add(TURN);
  f.coordination.beginTranscriptRewrite(SESSION).commit();
  f.persistAssistant({ id: "stale", content: "", status: "complete" });
  assert.equal(f.enqueued.length, 0);
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});

test("a non-empty complete assistant message is persisted", () => {
  const f = fixture();
  f.persistAssistant({ id: "m6", content: "done", status: "complete" });
  assert.equal(f.enqueued.length, 1);
});
