import { readMainModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { IPC } from "@pi-desktop/shared";
import { createAgentHostBridge } from "../electron/main/agent-host-bridge.ts";

// Exercise the actual desktop finalizer with the real bridge and Agent Host,
// without booting Electron or making a provider request.
const main = await readMainModule("runtime/plans.ts");
const start = main.indexOf("function finishTurn(");
const end = main.indexOf("async function finishApprovedExecution(", start);
assert.ok(start >= 0 && end > start);
const finalizer = ts.transpileModule(main.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const activeTurns = new Map([["s1", "initial"]]);
  const turnFinalizations = new Map();
  const persistedQueue = new Map();
  const prompts = [];
  const writes = [];
  const context = {
    activeTurns,
    turnFinalizations,
    activeTurnUsages: new Map(),
    planSubmissionTurnIds: new Set(),
    turnSettlements: new Map(),
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    planSubmissionTurnKey: (sessionId, turnId) => `${sessionId}:${turnId}`,
    shouldCreateTaskNotification: () => false,
    logger: { app() {} },
    setTimeout: () => ({ unref() {} }),
    quitting: false,
    isQuitting: () => context.quitting,
  };
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
      throw new Error(`Unexpected host call: ${method}`);
    },
  };
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => host,
    isSessionBusy: (id) => activeTurns.has(id) || turnFinalizations.has(id),
    log() {},
    async invoke(channel, [request]) {
      assert.equal(channel, IPC.invoke.agentPrompt);
      assert.equal(activeTurns.has(request.sessionId), false, "previous turn must release ownership");
      assert.equal(turnFinalizations.has(request.sessionId), false, "finalization must settle before dispatch");
      prompts.push(request);
      const turnId = `runtime-${prompts.length}`;
      activeTurns.set(request.sessionId, turnId);
      bridge.ingest({ sessionId: request.sessionId, turnId, ts: Date.now(), event: { type: "agent_start" } });
      return { accepted: true, turnId };
    },
  });
  Object.assign(context, {
    host,
    agentHostBridge: bridge,
    runtimeState: { host, agentHostBridge: bridge },
  });
  const finishTurn = runInNewContext(`${finalizer}\nfinishTurn;`, context);
  bridge.ingest({ sessionId: "s1", turnId: "initial", ts: Date.now(), event: { type: "agent_start" } });

  function finish(status = "completed") {
    const turnId = activeTurns.get("s1");
    if (status === "aborted") bridge.markAborting("s1");
    bridge.ingest({
      sessionId: "s1", turnId, ts: Date.now(),
      event: status === "error"
        ? { type: "error", error: { code: "PROVIDER_ERROR", message: "Fixture failure", retriable: false } }
        : { type: "agent_end", messageIds: [] },
    });
    return finishTurn("s1", status);
  }
  return { bridge, context, activeTurns, turnFinalizations, persistedQueue, prompts, writes, finish, finishTurn };
}

for (const status of ["completed", "error", "aborted"]) {
  test(`queued prompts resume once, in FIFO order, after ${status} turn finalization`, async () => {
    const f = fixture();
    await f.bridge.queue.push({ sessionId: "s1", content: "first follow-up" });
    await f.bridge.queue.push({ sessionId: "s1", content: "second follow-up" });
    f.activeTurns.set("s2", "other-session");
    await f.bridge.queue.push({ sessionId: "s2", content: "unrelated follow-up" });

    const pending = f.finish(status);
    assert.equal(f.finish(status), pending, "duplicate terminal handling must share the same write");
    await setImmediate();
    assert.equal(f.writes.length, 1);
    assert.equal(f.prompts.length, 0, "terminal event must not bypass durable finalization");
    assert.equal(f.persistedQueue.size, 3);

    f.writes[0].resolve({ ok: true });
    await pending;
    await setImmediate();
    assert.deepEqual(f.prompts.map((p) => p.content), ["first follow-up"]);
    assert.equal(f.bridge.queue.list("s1").length, 1);
    assert.equal(f.bridge.queue.list("s2").length, 1);
    assert.equal(f.persistedQueue.size, 2);

    const next = f.finish();
    await setImmediate();
    assert.equal(f.prompts.length, 1, "remaining queue must wait for the next turn too");
    f.writes[1].resolve({ ok: true });
    await next;
    await setImmediate();
    assert.deepEqual(f.prompts.map((p) => p.content), ["first follow-up", "second follow-up"]);
    assert.equal(f.bridge.queue.list("s1").length, 0);
    assert.equal(f.persistedQueue.size, 1);
  });
}

test("a settled persistence failure does not leave the queue asleep", async () => {
  const f = fixture();
  await f.bridge.queue.push({ sessionId: "s1", content: "follow-up" });
  const pending = f.finish();
  f.writes[0].reject(new Error("Fixture persistence failure"));
  await pending;
  await setImmediate();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.turnFinalizations.size, 0);
});

test("turn finalization during app shutdown preserves queued work without starting it", async () => {
  const f = fixture();
  await f.bridge.queue.push({ sessionId: "s1", content: "follow-up" });
  const pending = f.finish();
  f.context.quitting = true;
  f.writes[0].resolve({ ok: true });
  await pending;
  await setImmediate();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.persistedQueue.size, 1);
  assert.equal(f.turnFinalizations.size, 0);
});
