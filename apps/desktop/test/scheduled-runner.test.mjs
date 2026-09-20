import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createScheduledRunner, executeScheduledTask } = await import(
  "../electron/main/runtime/scheduled-runner.ts"
);

test("scheduled execution launches the durable session through the prompt boundary", async () => {
  const calls = [];
  const runs = new Map();
  const host = {
    async call(method, params) {
      calls.push([method, params]);
      return { sessionId: "session", runId: "run", prompt: "Inspect project" };
    },
  };
  const result = await executeScheduledTask({
    host,
    id: "task",
    automatic: true,
    runs,
    isCurrent: () => true,
    prompt: async (sessionId, content) => {
      assert.equal(runs.get(sessionId), "run");
      assert.equal(content, "Inspect project");
    },
  });
  assert.equal(result.sessionId, "session");
  assert.deepEqual(calls, [["scheduled.run", { id: "task", automatic: true }]]);
});

test("dispatch failure is recorded and cannot leave an overlapping active run", async () => {
  const calls = [];
  const runs = new Map();
  const host = {
    async call(method, params) {
      calls.push([method, params]);
      return { sessionId: "session", runId: "run", prompt: "Inspect" };
    },
  };
  await assert.rejects(
    executeScheduledTask({
      host,
      id: "task",
      automatic: false,
      runs,
      isCurrent: () => true,
      prompt: async () => {
        throw new Error("provider unavailable");
      },
    }),
    /provider unavailable/,
  );
  assert.equal(runs.size, 0);
  assert.deepEqual(calls.at(-1), [
    "scheduled.finishRun",
    { runId: "run", status: "error", errorCode: "SCHEDULE_DISPATCH_FAILED" },
  ]);
});

test("a stale host cannot launch into a replacement runtime", async () => {
  let prompted = false;
  const host = {
    async call() {
      return { sessionId: "session", runId: "run", prompt: "Inspect" };
    },
  };
  await assert.rejects(
    executeScheduledTask({
      host,
      id: "task",
      automatic: true,
      runs: new Map(),
      isCurrent: () => false,
      prompt: async () => {
        prompted = true;
      },
    }),
    /stopped/,
  );
  assert.equal(prompted, false);
});

test("dispatch and ledger failures remain diagnosable together", async () => {
  const host = { async call(method) {
    if (method === "scheduled.finishRun") throw new Error("ledger unavailable");
    return { sessionId: "session", runId: "run", prompt: "Inspect" };
  } };
  await assert.rejects(executeScheduledTask({ host, id: "task", automatic: true,
    runs: new Map(), isCurrent: () => true,
    prompt: async () => { throw new Error("provider unavailable"); },
  }), (error) => error instanceof AggregateError && error.errors.map((item) => item.message).join(",") === "provider unavailable,ledger unavailable");
});

test("polls serialize; stop prevents dispatch after a pending due response", async () => {
  let resolve;
  let polls = 0;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const host = {
    async call() {
      polls++;
      return pending;
    },
  };
  const executed = [];
  const runner = createScheduledRunner({
    getHost: () => host,
    execute: async (id) => executed.push(id),
    report: (e) => {
      throw e;
    },
  });
  const tick = runner.tick();
  await runner.tick();
  assert.equal(polls, 1);
  runner.stop();
  resolve({ ids: ["task"] });
  await tick;
  assert.deepEqual(executed, []);
});

test("failure of one task does not suppress another due task", async () => {
  const executed = [],
    errors = [];
  const host = {
    async call() {
      return { ids: ["a", "b"] };
    },
  };
  const runner = createScheduledRunner({
    getHost: () => host,
    execute: async (id) => {
      executed.push(id);
      if (id === "a") throw new Error("failed");
    },
    report: (error) => errors.push(error.message),
  });
  await runner.tick();
  runner.stop();
  assert.deepEqual(executed, ["a", "b"]);
  assert.deepEqual(errors, ["failed"]);
});
