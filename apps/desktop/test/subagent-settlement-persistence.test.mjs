import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");

test("a settled Task snapshot survives outbox recovery with its original turn and metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-settlement-"));
  const silent = () => undefined;
  try {
    const persistenceOutbox = new PersistenceOutbox(dir, silent);
    const queued = [];
    const enqueue = persistenceOutbox.enqueue.bind(persistenceOutbox);
    persistenceOutbox.enqueue = (...args) => {
      const pending = enqueue(...args);
      queued.push(pending);
      return pending;
    };
    const { persistAgentEvent } = createEventPersistence({
      runtimeState: { host: null },
      activeTurns: new Map([["session", "newer-turn"]]),
      activeToolCalls: new Map(),
      activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
      approvedExecutionIdsBySession: new Map(),
      approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(),
      planSubmissionTurnIds: new Set(),
      persistenceOutbox,
      logger: { app: silent },
    });
    const message = {
      id: "task-call", role: "tool", toolName: "Task", toolCallId: "task-call",
      toolArgs: { agent: "explorer", task: "Inspect the code" },
      toolStatus: "success", status: "complete", content: "completed",
      createdAt: "2026-09-13T00:00:00.000Z", toolDurationMs: 5,
      toolUsage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      toolResult: { details: { delegationId: "delegate", status: "completed", completedAt: 1000 } },
    };
    persistAgentEvent({ sessionId: "session", turnId: "original-turn", ts: 1000,
      event: { type: "message_end", message } });
    await Promise.all(queued);
    await persistenceOutbox.flush(() => null);
    assert.equal(persistenceOutbox.size(), 1);
    const recovered = new PersistenceOutbox(dir, silent);
    const writes = [];
    await recovered.flush(() => ({ isAvailable: () => true, call: async (method, params) => {
      writes.push({ method, params });
      return {};
    } }));
    assert.equal(recovered.size(), 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "session.appendMessage");
    assert.equal(writes[0].params.turnId, "original-turn");
    assert.deepEqual(writes[0].params.message, message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("settlement replacing an in-flight Task append is written after the initial snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-outbox-race-"));
  const outbox = new PersistenceOutbox(dir, () => undefined);
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const pending = new Promise((resolve) => { releaseFirst = resolve; });
  const written = [];
  const host = { isAvailable: () => true, call: async (_method, params) => {
    written.push(params.message);
    if (written.length === 1) {
      firstStarted();
      await pending;
    }
    return {};
  } };
  try {
    const entry = { key: "message:session:task", sessionId: "session", turnId: "turn" };
    await outbox.enqueue({ ...entry, message: { status: "running" } }, () => host);
    await started;
    await outbox.enqueue({ ...entry, message: { status: "completed" } }, () => host);
    releaseFirst();
    await outbox.flush(() => host);
    assert.deepEqual(written, [{ status: "running" }, { status: "completed" }]);
    assert.equal(outbox.size(), 0);
  } finally {
    releaseFirst();
    await outbox.flush(() => host);
    await rm(dir, { recursive: true, force: true });
  }
});
