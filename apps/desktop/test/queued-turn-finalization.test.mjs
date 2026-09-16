import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
// Node strips the types itself; the hook only supplies the `.ts` extension the
// bundler-style relative imports omit.
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// Exercise the real plan runtime, the real turn coordination state and the real
// Agent Host bridge, without booting Electron or making a provider request.
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);
const { createAgentHostBridge } = await import(
  "../electron/main/agent-host-bridge.ts"
);
const { IPC } = await import("@pi-desktop/shared");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const SESSION = "s1";
const FIRST_TURN = "initial";

function fixture() {
  const activeTurns = new Map([[SESSION, FIRST_TURN]]);
  const persistedQueue = new Map();
  const prompts = [];
  const writes = [];
  const announcements = [];
  let quitting = false;

  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });

  const host = {
    async call(method, params) {
      if (method === "session.get") {
        return { session: { id: params.id, permissionMode: "ask" } };
      }
      if (method === "session.queuePush") {
        persistedQueue.set(params.id, params);
        return {};
      }
      if (method === "session.queueRemove") {
        return { removed: persistedQueue.delete(params.id) };
      }
      if (method === "session.endTurn") {
        const write = deferred();
        writes.push({ ...write, turnId: params.turnId });
        return write.promise;
      }
      if (method === "session.queuePrioritize") {
        return {};
      }
      if (method === "session.queueList") {
        return { entries: [...persistedQueue.values()] };
      }
      throw new Error(`Unexpected host call: ${method}`);
    },
  };

  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => host,
    // The shared busy check, exactly as the application wires it: a turn whose
    // announcement has not run yet must still hold the queue.
    isSessionBusy: coordination.isSessionBusy,
    log() {},
    async invoke(channel, [request]) {
      assert.equal(channel, IPC.invoke.agentPrompt);
      assert.equal(
        activeTurns.has(request.sessionId),
        false,
        "previous turn must release ownership",
      );
      assert.equal(
        coordination.isSessionBusy(request.sessionId),
        false,
        "finalization must settle before dispatch",
      );
      prompts.push(request);
      const turnId = `runtime-${prompts.length}`;
      activeTurns.set(request.sessionId, turnId);
      bridge.ingest({
        sessionId: request.sessionId,
        turnId,
        ts: Date.now(),
        event: { type: "agent_start" },
      });
      return { accepted: true, turnId };
    },
  });

  const planRuntime = createPlanRuntime({
    runtimeState: { host, agentHostBridge: bridge },
    planState: { approvedExecutionDrain: null },
    logger: { app() {} },
    sendToRenderer() {},
    coordination,
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(),
    finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(),
    pendingExecutionFinishes: new Map(),
    announceTurnEnded: (payload) => announcements.push(payload),
    emitAgentEvent() {},
    acquireSessionOperation: coordination.acquireSessionOperation,
    resolveAgentRuntimeLaunch: async () => {
      throw new Error("not used by this fixture");
    },
    isQuitting: () => quitting,
  });

  bridge.ingest({
    sessionId: SESSION,
    turnId: FIRST_TURN,
    ts: Date.now(),
    event: { type: "agent_start" },
  });

  /**
   * Reproduce one terminal event: the runtime ingests it, then the persistence
   * pass finalizes the turn with the identity the event carried.
   */
  function finish(status = "completed", { deliverTerminal = true } = {}) {
    const turnId = activeTurns.get(SESSION);
    if (status === "aborted") {
      bridge.markAborting(SESSION);
      coordination.lockAbortReason(SESSION, turnId);
    }
    // A real abort can lose this event: `isStaleTerminalEvent` drops a terminal
    // event for a turn main no longer owns, and the runtime may never emit one.
    if (deliverTerminal) {
      bridge.ingest({
        sessionId: SESSION,
        turnId,
        ts: Date.now(),
        event:
          status === "error"
            ? {
                type: "error",
                error: {
                  code: "PROVIDER_ERROR",
                  message: "Fixture failure",
                  retriable: false,
                },
              }
            : { type: "agent_end", messageIds: [] },
      });
    }
    return planRuntime.finishTurn(SESSION, status, undefined, { turnId });
  }

  return {
    bridge,
    coordination,
    activeTurns,
    turnFinalizations: coordination.turnFinalizations,
    persistedQueue,
    prompts,
    announcements,
    writes,
    finish,
    finishTurn: planRuntime.finishTurn,
    setQuitting: (value) => {
      quitting = value;
    },
  };
}

for (const status of ["completed", "error", "aborted"]) {
  test(`queued prompts resume once, in FIFO order, after ${status} turn finalization`, async () => {
    const f = fixture();
    await f.bridge.queue.push({ sessionId: SESSION, content: "first follow-up" });
    await f.bridge.queue.push({ sessionId: SESSION, content: "second follow-up" });
    f.activeTurns.set("s2", "other-session");
    await f.bridge.queue.push({ sessionId: "s2", content: "unrelated follow-up" });

    const pending = f.finish(status);
    assert.equal(
      f.finish(status),
      pending,
      "duplicate terminal handling must share the same write",
    );
    await setImmediate();
    assert.equal(f.writes.length, 1);
    assert.equal(
      f.prompts.length,
      0,
      "terminal event must not bypass durable finalization",
    );
    assert.equal(f.persistedQueue.size, 3);

    f.writes[0].resolve({ ok: true });
    await pending;
    await setImmediate();
    assert.deepEqual(
      f.prompts.map((p) => p.content),
      ["first follow-up"],
    );
    assert.equal(f.bridge.queue.list(SESSION).length, 1);
    assert.equal(f.bridge.queue.list("s2").length, 1);
    assert.equal(f.persistedQueue.size, 2);
    // One host turn ends once, with the reason it actually ended for.
    assert.deepEqual(f.announcements, [
      { sessionId: SESSION, turnId: FIRST_TURN, reason: status },
    ]);

    const next = f.finish();
    await setImmediate();
    assert.equal(
      f.prompts.length,
      1,
      "remaining queue must wait for the next turn too",
    );
    f.writes[1].resolve({ ok: true });
    await next;
    await setImmediate();
    assert.deepEqual(
      f.prompts.map((p) => p.content),
      ["first follow-up", "second follow-up"],
    );
    assert.equal(f.bridge.queue.list(SESSION).length, 0);
    assert.equal(f.persistedQueue.size, 1);
  });
}

test("a settled persistence failure does not leave the queue asleep", async () => {
  const f = fixture();
  await f.bridge.queue.push({ sessionId: SESSION, content: "follow-up" });
  const pending = f.finish();
  // The finalization claims the turn synchronously but starts its durable write
  // on the next microtask, so the pending write exists one turn of the loop
  // later. This is the window the plan's step 3 is about.
  assert.equal(f.writes.length, 0, "the write is deferred, not skipped");
  await setImmediate();
  assert.equal(f.writes.length, 1);
  f.writes[0].reject(new Error("Fixture persistence failure"));
  await pending;
  await setImmediate();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.turnFinalizations.size, 0);
  // The durable write failed, so the turn is not claimed as settled, but the
  // plugins are still told it ended: the announcement is not conditional on
  // persistence succeeding.
  assert.deepEqual(f.announcements, [
    { sessionId: SESSION, turnId: FIRST_TURN, reason: "completed" },
  ]);
});

test("turn finalization during app shutdown preserves queued work without starting it", async () => {
  const f = fixture();
  await f.bridge.queue.push({ sessionId: SESSION, content: "follow-up" });
  const pending = f.finish();
  f.setQuitting(true);
  await setImmediate();
  f.writes[0].resolve({ ok: true });
  await pending;
  await setImmediate();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.persistedQueue.size, 1);
  assert.equal(f.turnFinalizations.size, 0);
});

test("a cancellation locked before the turn settles decides the announced reason", async () => {
  const f = fixture();
  // The lock is recorded while the cancel request is in flight; the terminal
  // event that arrives afterwards must not restate the abort as a completion.
  f.coordination.lockAbortReason(SESSION, FIRST_TURN);
  const pending = f.finish("completed");
  await setImmediate();
  f.writes[0].resolve({ ok: true });
  await pending;
  await setImmediate();
  assert.deepEqual(f.announcements, [
    { sessionId: SESSION, turnId: FIRST_TURN, reason: "aborted" },
  ]);
  // The lock does not outlive the turn that owns it.
  assert.equal(
    f.coordination.peekAbortReason(SESSION, FIRST_TURN),
    undefined,
  );
});

test("a terminal event naming a turn that no longer owns the session settles nothing", async () => {
  const f = fixture();
  const first = f.finish();
  await setImmediate();
  f.writes[0].resolve({ ok: true });
  await first;
  await setImmediate();
  assert.equal(f.announcements.length, 1);

  // The finished turn no longer owns the session, so a repeated terminal event
  // opens no second finalization: no extra durable write, no second
  // announcement, and no new record to hold the queue.
  const repeated = f.finish();
  await repeated;
  await setImmediate();
  assert.equal(f.writes.length, 1, "no second durable endTurn may be issued");
  assert.equal(f.announcements.length, 1);
  assert.equal(f.turnFinalizations.size, 0);
});

test("a turn whose session moved on releases its waiters and its cancellation lock", async () => {
  const f = fixture();
  const NEXT_TURN = "next";
  // The turn was cancelled while it ran, and a plan submission is waiting for it
  // to settle before it may dispatch.
  f.coordination.lockAbortReason(SESSION, FIRST_TURN);
  const settlement = f.coordination.waitForTurnSettlement(SESSION, FIRST_TURN);
  let settled = false;
  void settlement.then(() => {
    settled = true;
  });

  // The session moved on before this turn could finalize itself: the crash
  // cleanup and the finalizer both refuse a settlement for a turn that no longer
  // owns the session, so only the refusal path can drop its records.
  f.activeTurns.set(SESSION, NEXT_TURN);
  await f.finishTurn(SESSION, "aborted", "PLAN_APPROVAL_INTERRUPTED", {
    turnId: FIRST_TURN,
  });
  await setImmediate();

  assert.equal(settled, true, "the settlement waiter must not be stranded");
  assert.equal(
    f.coordination.peekAbortReason(SESSION, FIRST_TURN),
    undefined,
    "the cancellation lock must not outlive its turn",
  );
  assert.equal(f.turnFinalizations.size, 0, "no finalization record is opened");
  assert.equal(f.announcements.length, 0, "a refused settlement announces nothing");
  assert.equal(
    f.coordination.isActiveTurn(SESSION, NEXT_TURN),
    true,
    "the newer turn keeps the session",
  );
});

test("a promoted queue resumes even when no terminal event reaches Agent Host", async () => {
  const f = fixture();
  await f.bridge.queue.push({ sessionId: SESSION, content: "promoted follow-up" });
  const [entry] = f.bridge.queue.list(SESSION);
  assert.ok(entry, "the queued row must be listed before it is promoted");
  // Send now, exactly as the renderer asks for it.
  await f.bridge.queue.prioritize(entry.id);

  // Abort: `isStaleTerminalEvent` drops the `agent_end` once main no longer owns
  // the turn, and the runtime does not have to emit one at all. The settlement
  // alone must release the queue.
  const pending = f.finish("aborted", { deliverTerminal: false });
  await setImmediate();
  f.writes[0].resolve({ ok: true });
  await pending;
  await setImmediate();

  assert.deepEqual(
    f.prompts.map((prompt) => prompt.content),
    ["promoted follow-up"],
    "a settled turn must start the promoted row without its terminal event",
  );
  assert.equal(f.bridge.queue.list(SESSION).length, 0);
  assert.equal(f.persistedQueue.size, 0, "the started row leaves the durable queue");
});

test("a stalled turn that main finalized never blocks the queue after a restart of the session's work", async () => {
  const f = fixture();
  await f.bridge.queue.push({ sessionId: SESSION, content: "waiting follow-up" });
  const pending = f.finish("aborted", { deliverTerminal: false });
  await setImmediate();
  f.writes[0].resolve({ ok: true });
  await pending;
  await setImmediate();
  // The session must be reported idle again: `isSessionBusy` reads the runtime's
  // own turn map, and Agent Host must not keep a settled turn active.
  assert.equal(f.coordination.isActiveTurn(SESSION, FIRST_TURN), false);
  assert.deepEqual(f.prompts.map((prompt) => prompt.content), ["waiting follow-up"]);
});
