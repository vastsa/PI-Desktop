import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildSessionSubagents, filterSessionSubagents, mergeSubagentMessages } =
  await import("../src/features/subagents/model.ts");

const row = (id, extra = {}) => ({
  id, role: "assistant", content: "", createdAt: "2026-11-01T00:00:00.000Z", ...extra,
});
const task = (id, delegationId, extra = {}) => row(id, {
  role: "tool", toolName: "Task", toolCallId: id,
  toolArgs: { agent: "explorer", task: "Inspect source", description: "Find source" },
  toolResult: { details: { delegationId, status: "running", modelId: "account/model" } },
  ...extra,
});

test("the session directory lists direct Task calls, not child or lifecycle rows", () => {
  const messages = [task("a", "del-a"), task("b", "del-b"),
    task("nested", "del-nested", { parentToolCallId: "a" }),
    row("wait", { role: "tool", toolName: "TaskWait" }),
    row("answer", { content: "Intermediate note", parentToolCallId: "a" })];
  const agents = buildSessionSubagents(messages, true);
  assert.deepEqual(agents.map((agent) => agent.delegationId), ["del-b", "del-a"]);
  assert.equal(agents[0].agentName, "explorer");
  assert.equal(agents[0].modelId, "account/model");
  assert.equal(agents[0].description, "Find source");
  assert.equal(agents[0].status, "running");
});

test("a resumed chain is one directory entry keyed by its original Task", () => {
  const first = task("first", "del-first", {
    toolResult: { details: { delegationId: "del-first", status: "completed" } },
  });
  const second = task("second", "del-second", {
    toolArgs: { agent: "explorer", task: "Continue", resume: "del-first" },
  });
  const agents = buildSessionSubagents([first, second], true);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].key, "first");
  assert.equal(agents[0].delegationId, "del-second");
  assert.deepEqual(agents[0].calls.map((call) => call.id), ["first", "second"]);
  assert.equal(agents[0].status, "running");
});

test("legacy direct result payloads and bare call-id resume links stay grouped", () => {
  const first = task("first", "del-first", {
    toolResult: { delegationId: "del-first", status: "completed" },
  });
  const second = task("second", "del-second", {
    toolArgs: { agent: "explorer", task: "Continue", resume: "first" },
  });
  assert.equal(buildSessionSubagents([first, second], true).length, 1);
});

test("terminal snapshots beat stale running lifecycle data; old running rows are aborted", () => {
  const complete = task("complete", "done", {
    toolResult: { details: { delegationId: "done", status: "completed" } },
  });
  const wait = row("wait", { role: "tool", toolName: "TaskList",
    toolResult: { details: { delegations: [{ delegationId: "done", status: "running" }] } },
  });
  assert.equal(buildSessionSubagents([complete, wait], true)[0].status, "completed");
  assert.equal(buildSessionSubagents([task("old", "old")], false)[0].status, "aborted");
});

test("search and outcome filters include the task and do not mutate the list", () => {
  const agents = buildSessionSubagents([
    task("a", "a"), task("b", "b", {
      toolArgs: { agent: "reviewer", task: "Audit permissions" },
      toolResult: { details: { delegationId: "b", status: "failed" } },
    }),
  ], true);
  assert.equal(filterSessionSubagents(agents, "permissions", "all")[0].delegationId, "b");
  assert.equal(filterSessionSubagents(agents, "REVIEWER", "failed").length, 1);
  assert.equal(filterSessionSubagents(agents, "", "running").length, 1);
  assert.equal(filterSessionSubagents(agents, "", "completed").length, 0);
  assert.equal(agents.length, 2);
});

test("new live rows replace persisted snapshots without duplicate ids or reordering", () => {
  const early = row("early", { createdAt: "2026-11-01T00:00:00.001Z" });
  const stale = row("stream", { content: "Old", createdAt: "2026-11-01T00:00:00.002Z" });
  const fresh = { ...stale, content: "New streamed text", status: "streaming" };
  const late = row("late", { createdAt: "2026-11-01T00:00:00.003Z" });
  const merged = mergeSubagentMessages([early, stale], [fresh, late]);
  assert.deepEqual(merged.map((message) => message.id), ["early", "stream", "late"]);
  assert.equal(merged[1], fresh);
  assert.equal(stale.content, "Old");
});

test("creating entries remain distinct until a stable delegation handle arrives", () => {
  const creating = task("creating", "", { toolStatus: "running", toolResult: undefined });
  const pending = buildSessionSubagents([creating], true)[0];
  assert.equal(pending.creating, true);
  assert.equal(pending.status, "running");
  const created = buildSessionSubagents([{ ...creating, toolStatus: "success",
    toolResult: { details: { delegationId: "stable-handle", status: "running" } },
  }], true)[0];
  assert.equal(created.creating, false);
  assert.equal(created.delegationId, "stable-handle");
});

test("bounded restored metadata preserves resume identity and issue outcomes despite successful Task calls", () => {
  const restored = task("first", "prior", { toolStatus: "success",
    toolArgs: { agent: "explorer", description: "bounded description", _truncated: true },
    toolResult: { content: "[truncated for display]", details: { delegationId: "prior", status: "completed" } },
  });
  const resumed = task("resumed", "latest", { toolStatus: "success",
    toolArgs: { agent: "explorer", description: "bounded description", resume: "prior", _truncated: true },
    toolResult: { content: "[truncated for display]", details: { delegationId: "latest", status: "failed", modelId: "fixture/model" } },
  });
  const stopped = task("stopped", "stopped", { toolStatus: "success",
    toolResult: { details: { delegationId: "stopped", status: "running" } },
  });
  const timedOut = task("timeout", "timeout", { toolStatus: "success",
    toolResult: { details: { delegationId: "timeout", status: "timed_out" } },
  });
  const stop = row("stop", { role: "tool", toolName: "functions.TaskStop",
    toolResult: { content: "[truncated for display]", details: {
      stopped: [{ delegationId: "stopped", status: "stopped" }],
    } },
  });
  const agents = buildSessionSubagents([restored, resumed, stopped, timedOut, stop], false);
  const chain = agents.find((agent) => agent.delegationId === "latest");
  assert.deepEqual(chain.calls.map((call) => call.id), ["first", "resumed"]);
  assert.equal(chain.modelId, "fixture/model");
  assert.equal(chain.status, "failed");
  assert.equal(filterSessionSubagents(agents, "", "completed").length, 0);
  assert.deepEqual(new Set(filterSessionSubagents(agents, "", "failed").map((agent) => agent.status)),
    new Set(["failed", "stopped", "timed_out"]));
});
