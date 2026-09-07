import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  collectDelegationStatuses,
  collectDelegationTimings,
  delegationRoster,
  delegationRosterOutcome,
  delegationRosterSummary,
  delegationTimingBounds,
  isDelegationActivityItem,
  lifecycleKindOf,
  subagentOutcome,
  summarizeSubagentActivity,
} = await import("../src/lib/subagent-topology.ts");

function task(id, toolStatus, resultStatus, timing = {}) {
  const message = {
    id,
    role: "tool",
    content: "",
    createdAt: "2026-08-10T00:00:00.000Z",
    toolName: "Task",
    toolCallId: id,
    toolStatus,
    toolArgs: { agent: "reviewer", description: `Task ${id}` },
    ...(resultStatus
      ? {
          toolResult: {
            details: {
              delegationId: id,
              status: resultStatus,
              ...timing,
            },
          },
        }
      : {}),
  };
  return { kind: "tool", message };
}

function lifecycle(toolName, details) {
  return {
    kind: "tool",
    message: {
      id: toolName,
      role: "tool",
      content: "",
      createdAt: "2026-08-10T00:00:00.000Z",
      toolName,
      toolCallId: toolName,
      toolStatus: "success",
      toolResult: { details },
    },
  };
}

test("detects exact delegation activities without absorbing ordinary tools", () => {
  assert.equal(isDelegationActivityItem(task("one", "running")), true);
  assert.equal(
    isDelegationActivityItem({
      kind: "tool",
      message: { ...task("read", "success").message, toolName: "Read" },
    }),
    false,
  );
  // The lifecycle tools of ADR 0087 drive an existing delegation and must not
  // inflate the topology's subagent counts.
  for (const toolName of ["TaskWait", "TaskList", "TaskStop"]) {
    assert.equal(
      isDelegationActivityItem({
        kind: "tool",
        message: { ...task("lifecycle", "success").message, toolName },
      }),
      false,
      `${toolName} is not a delegation activity item`,
    );
  }
  assert.equal(
    isDelegationActivityItem({
      kind: "thinking",
      message: { ...task("thought", "success").message, role: "assistant" },
    }),
    false,
  );
});

test("prefers the structured delegate outcome over the transport status", () => {
  assert.equal(subagentOutcome(task("running", "running").message), "running");
  assert.equal(
    subagentOutcome(task("done", "success", "completed").message),
    "completed",
  );
  assert.equal(
    subagentOutcome(task("cap", "success", "truncated").message),
    "truncated",
  );
  assert.equal(
    subagentOutcome(task("stop", "success", "aborted").message),
    "aborted",
  );
  assert.equal(
    subagentOutcome(task("stopped", "success", "stopped").message),
    "stopped",
  );
  assert.equal(
    subagentOutcome(task("fail", "success", "failed").message),
    "failed",
  );
  assert.equal(subagentOutcome(task("denied", "denied").message), "denied");
});

test("uses delegation lifecycle timestamps instead of the immediate Task duration", () => {
  const timings = collectDelegationTimings([
    task("running", "success", "running", { startedAt: 1_000 }),
    lifecycle("TaskWait", {
      status: "completed",
      delegations: [
        {
          delegationId: "running",
          agent: "reviewer",
          status: "completed",
          startedAt: 1_000,
          completedAt: 4_250,
        },
      ],
    }),
  ]);

  assert.deepEqual(timings.get("running"), {
    startedAt: 1_000,
    completedAt: 4_250,
  });
});

test("reads settled delegation status from a persisted TaskWait result", () => {
  const statuses = collectDelegationStatuses([
    task("running", "success", "running"),
    lifecycle("TaskWait", {
      delegations: [
        {
          delegationId: "running",
          status: "completed",
          startedAt: 1_000,
          completedAt: 4_250,
        },
      ],
    }),
  ]);

  assert.equal(statuses.get("running"), "completed");
  assert.equal(
    subagentOutcome(task("running", "success", "running").message, statuses),
    "completed",
  );
});

test("reads stopped status from TaskStop, including a running snapshot", () => {
  const statuses = collectDelegationStatuses([
    task("d1", "success", "running"),
    lifecycle("TaskStop", {
      stopped: [
        { delegationId: "d1", agent: "explorer", status: "running" },
      ],
    }),
  ]);
  assert.equal(statuses.get("d1"), "stopped");
  assert.equal(
    subagentOutcome(task("d1", "success", "running").message, statuses),
    "stopped",
  );
});

test("a finished turn treats leftover running delegates as aborted", () => {
  const live = collectDelegationStatuses(
    [task("d1", "success", "running")],
    { turnLive: true },
  );
  assert.equal(live.get("d1"), undefined);
  assert.equal(
    subagentOutcome(task("d1", "success", "running").message, live),
    "running",
  );
  const settled = collectDelegationStatuses(
    [task("d1", "success", "running")],
    { turnLive: false },
  );
  assert.equal(settled.get("d1"), "aborted");
  assert.equal(
    subagentOutcome(task("d1", "success", "running").message, settled),
    "aborted",
  );
});

test("summarizes partial fan-out without deduplicating repeated agent names", () => {
  assert.deepEqual(
    summarizeSubagentActivity([
      task("one", "running"),
      task("two", "success", "completed"),
      task("three", "success", "truncated"),
      task("four", "success", "aborted"),
      task("five", "success", "stopped"),
      task("six", "error", "failed"),
      task("seven", "denied"),
    ]),
    {
      total: 7,
      finished: 6,
      running: 1,
      issues: 2,
      warnings: 3,
    },
  );
  assert.deepEqual(summarizeSubagentActivity([]), {
    total: 0,
    finished: 0,
    running: 0,
    issues: 0,
    warnings: 0,
  });
});

test("a lifecycle row names the subagents it reports on (D268)", () => {
  // Presentation parity with the Task card: the row was called with bare
  // delegation ids, so its own arguments say nothing a reader can use. The
  // roster the runtime returned is what names the subagents.
  const wait = lifecycle("TaskWait", {
    delegations: [
      {
        delegationId: "d1",
        agent: "explorer",
        status: "completed",
        startedAt: 1000,
        completedAt: 4000,
      },
      { delegationId: "d2", agent: "fixer", status: "failed" },
    ],
  });
  assert.equal(lifecycleKindOf(wait.message), "wait");
  const roster = delegationRoster(wait.message);
  assert.deepEqual(roster, [
    {
      delegationId: "d1",
      agentName: "explorer",
      status: "completed",
      durationMs: 3000,
    },
    { delegationId: "d2", agentName: "fixer", status: "failed" },
  ]);
  assert.equal(delegationRosterSummary(roster), "explorer, fixer");
  // A failure in the roster outranks a completed sibling.
  assert.equal(delegationRosterOutcome(roster), "failed");
});

test("a repeated agent is counted, not listed twice", () => {
  const list = lifecycle("TaskList", {
    delegations: [
      { delegationId: "a", agent: "explorer", status: "completed" },
      { delegationId: "b", agent: "explorer", status: "completed" },
      { delegationId: "c", agent: "code-reviewer", status: "running" },
    ],
  });
  const roster = delegationRoster(list.message);
  assert.equal(delegationRosterSummary(roster), "explorer ×2, code-reviewer");
  // Anything still running keeps the whole row reading as running.
  assert.equal(delegationRosterOutcome(roster), "running");
});

test("TaskStop reads its roster from `stopped`, and Task has none", () => {
  const stop = lifecycle("TaskStop", {
    stopped: [{ delegationId: "s1", agent: "test-runner", status: "stopped" }],
  });
  assert.equal(lifecycleKindOf(stop.message), "stop");
  assert.equal(delegationRosterSummary(delegationRoster(stop.message)), "test-runner");
  assert.equal(delegationRosterOutcome(delegationRoster(stop.message)), "stopped");
  const stale = lifecycle("TaskStop", {
    stopped: [{ delegationId: "s2", agent: "explorer", status: "running" }],
  });
  assert.equal(delegationRosterOutcome(delegationRoster(stale.message)), "stopped");
  // The start call is not a lifecycle row: it keeps the topology card.
  const start = task("one", "running");
  assert.equal(lifecycleKindOf(start.message), null);
  assert.deepEqual(delegationRoster(start.message), []);
  assert.equal(delegationRosterSummary([]), "");
  assert.equal(delegationRosterOutcome([]), null);
});

test("topology elapsed bounds follow this card's Task ids, not a later fan-out", () => {
  const first = task("d1", "success", "running", {
    startedAt: 1_000,
  });
  const second = task("d2", "success", "completed", {
    startedAt: 2_000,
    completedAt: 5_000,
  });
  const later = task("d3", "success", "completed", {
    startedAt: 10_000,
    completedAt: 40_000,
  });
  const timings = collectDelegationTimings([first, second, later]);
  const running = delegationTimingBounds([first, second], timings);
  assert.equal(running.startedAt, 1_000);
  assert.equal(running.completedAt, undefined);
  const settled = collectDelegationTimings([
    task("d1", "success", "completed", { startedAt: 1_000, completedAt: 4_000 }),
    second,
  ]);
  assert.deepEqual(
    delegationTimingBounds(
      [
        task("d1", "success", "completed", {
          startedAt: 1_000,
          completedAt: 4_000,
        }),
        second,
      ],
      settled,
    ),
    { startedAt: 1_000, completedAt: 5_000 },
  );
});
