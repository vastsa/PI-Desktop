import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createScheduledRunner, executeScheduledTask } = await import(
  "../electron/main/runtime/scheduled-runner.ts"
);

test("slow dispatch does not hold later tasks or subsequent polls", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const launched = [];
  let ids = ["slow", "other"];
  const host = { async call() { return { ids }; } };
  const runner = createScheduledRunner({getHost:()=>host, report:(error)=>{throw error;},
    execute:async(id)=>{launched.push(id);if(id==="slow"){enter();await blocked;}}});
  const first = runner.tick();
  await entered;
  // Drain the promise continuations, without releasing the slow preparation.
  await new Promise((resolve)=>setImmediate(resolve));
  const beforeRelease = [...launched];
  ids = ["slow", "third"];
  await runner.tick();
  await new Promise((resolve)=>setImmediate(resolve));
  const afterPoll = [...launched];
  runner.stop(); release(); await first;
  assert.deepEqual(beforeRelease,["slow","other"]);
  assert.deepEqual(afterPoll,["slow","other","third"]);
});

test("a replacement host owns its dispatch even when an old setup settles", async () => {
  const firstHost={async call(){return {ids:["task","task"]};}};
  const secondHost={async call(){return {ids:["task","task"]};}};
  let host=firstHost;
  const releases=[];const starts=[];
  const runner=createScheduledRunner({getHost:()=>host,report:()=>{},execute:(id)=>{
    starts.push({host,id});return new Promise(resolve=>releases.push(resolve));
  }});
  await runner.tick();assert.equal(starts.length,1);
  host=secondHost;await runner.tick();assert.equal(starts.length,2);
  releases[0]();await new Promise(resolve=>setImmediate(resolve));
  await runner.tick();assert.equal(starts.length,2,"old cleanup must not clear replacement owner");
  runner.stop();releases[1]();await new Promise(resolve=>setImmediate(resolve));
  await runner.tick();assert.equal(starts.length,2);
});

test("a rejected startup remains observable and releases its local owner", async () => {
  const host={async call(){return {ids:["task"]};}};
  let attempts=0;const errors=[];
  const runner=createScheduledRunner({getHost:()=>host,report:error=>errors.push(error.message),execute:async()=>{
    attempts++;throw new Error("setup failed");
  }});
  await runner.tick();await new Promise(resolve=>setImmediate(resolve));
  await runner.tick();await new Promise(resolve=>setImmediate(resolve));runner.stop();
  assert.equal(attempts,2);assert.deepEqual(errors,["setup failed","setup failed"]);
});

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
