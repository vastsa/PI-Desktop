import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const {
  activityCountParts,
  activitySummary,
  visibleActivityItems,
} = await import("../src/lib/activity-summary.ts");
const { catalogs, flattenCatalog } = await import("@pi-desktop/i18n");

/**
 * The header resolves its counter keys as variables, so the renderer key scan
 * cannot see them: assert the contract here, for every shipped locale.
 */
test("every category counter key exists in every shipped catalog", () => {
  const keys = activityCountParts({
    toolCalls: 1,
    commandExecutions: 1,
    searchRounds: 1,
    thinkingSteps: 1,
    issues: 0,
  }).map((part) => part.key);
  assert.equal(keys.length, 4);
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of keys) {
      assert.ok(key in flat || `${key}_one` in flat, `${id} is missing ${key}`);
      assert.ok(`${key}_other` in flat, `${id} is missing ${key}_other`);
    }
  }
});
const message = (id, role, content, extra = {}) => ({
  id,
  role,
  content,
  createdAt: "2026-09-23T00:00:00.000Z",
  ...extra,
});

const tool = (id, toolName, extra = {}) =>
  message(id, "tool", "result", { toolName, toolCallId: `call-${id}`, ...extra });

const hostedSearch = (id, rounds) =>
  message(id, "assistant", "", {
    hostedSearch: { status: "completed", rounds },
  });

const round = (id, extra = {}) => ({ id, status: "completed", sources: [], ...extra });

/** Every activity item one turn produced, in transcript order. */
const items = (messages) => {
  const entry = buildTranscriptEntries(messages).entries.find(
    (candidate) => candidate.kind === "assistant-turn",
  );
  assert.ok(entry, "expected one assistant turn");
  return entry.parts.flatMap((part) => (part.kind === "activity" ? part.items : []));
};

test("mixed work splits into tool calls, commands, search rounds and thinking", () => {
  const summary = activitySummary(
    items([
      message("u", "user", "Inspect"),
      message("intro", "assistant", "Looking", { thinking: "Plan" }),
      tool("read", "Read"),
      tool("grep", "Grep"),
      tool("bash", "Bash"),
      hostedSearch("search", [round("r1"), round("r2")]),
      message("final", "assistant", "Done"),
    ]),
  );
  assert.deepEqual(summary, {
    toolCalls: 2,
    commandExecutions: 1,
    searchRounds: 2,
    thinkingSteps: 1,
    issues: 0,
  });
});

test("the work categories partition the items instead of overlapping", () => {
  const activityItems = items([
    message("intro", "assistant", "Looking", { thinking: "Plan" }),
    tool("bash", "Bash"),
    tool("read", "Read"),
    hostedSearch("search", [round("r1"), round("r2")]),
  ]);
  const summary = activitySummary(activityItems);
  const nonThinking = activityItems.filter((item) => item.kind !== "thinking").length;
  assert.equal(
    summary.toolCalls + summary.commandExecutions + summary.searchRounds,
    nonThinking,
  );
  // A command execution is not also a tool call.
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.commandExecutions, 1);
});

test("hosted search rounds never count as tool calls", () => {
  const activityItems = items([hostedSearch("search", [round("r1"), round("r2")])]);
  const summary = activitySummary(activityItems);
  assert.equal(summary.toolCalls, 0);
  assert.equal(summary.commandExecutions, 0);
  assert.equal(summary.searchRounds, 2);
  assert.deepEqual(activityCountParts(summary), [
    { key: "chat.activitySearches", count: 2 },
  ]);
});

test("delegated child work stays out of its parent turn counts", () => {
  const summary = activitySummary(
    items([
      message("u", "user", "Delegate"),
      tool("task", "Task", {
        toolResult: { delegationId: "d1", status: "running" },
      }),
      message("nested-think", "assistant", "", {
        thinking: "Delegate reasoning",
        parentToolCallId: "call-task",
      }),
      tool("nested-read", "Read", { parentToolCallId: "call-task" }),
      message("final", "assistant", "Report"),
    ]),
  );
  // Only the Task call itself is the parent turn's own tool call.
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.commandExecutions, 0);
  assert.equal(summary.thinkingSteps, 0);
});

test("issues keep counting failures and denials", () => {
  const summary = activitySummary(
    items([
      tool("failed-bash", "Bash", {
        toolStatus: "error",
        isError: true,
        toolResult: { details: { exitCode: 1 } },
      }),
      tool("denied", "Write", { toolStatus: "denied" }),
      tool("task", "Task", { toolStatus: "error", isError: true }),
      tool("read", "Read", { toolStatus: "success" }),
      message("final", "assistant", "Done"),
    ]),
  );
  assert.equal(summary.issues, 3);
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.commandExecutions, 1);
});

test("compact mode drops reasoning the reader cannot see", () => {
  const completedReasoning = message("think", "assistant", "", {
    thinking: "Private reasoning",
    status: "complete",
  });
  const streamingReasoning = message("live", "assistant", "", {
    thinking: "Live reasoning",
    status: "streaming",
  });
  const activityItems = items([completedReasoning, tool("read", "Read")]);
  assert.equal(activitySummary(visibleActivityItems(activityItems, true, false)).thinkingSteps, 0);
  assert.equal(activitySummary(activityItems).thinkingSteps, 1);


  const liveItems = items([streamingReasoning, tool("read", "Read")]);
  assert.equal(activitySummary(visibleActivityItems(liveItems, true, true)).thinkingSteps, 1);
  assert.equal(activitySummary(visibleActivityItems(liveItems, true, false)).thinkingSteps, 0);
});

test("count parts drop empty categories and keep their order", () => {
  assert.deepEqual(
    activityCountParts({
      toolCalls: 0,
      commandExecutions: 0,
      searchRounds: 0,
      thinkingSteps: 3,
      issues: 0,
    }),
    [{ key: "chat.activityThinking", count: 3 }],
  );
  assert.deepEqual(
    activityCountParts({
      toolCalls: 5,
      commandExecutions: 2,
      searchRounds: 1,
      thinkingSteps: 3,
      issues: 1,
    }),
    [
      { key: "chat.activityToolCalls", count: 5 },
      { key: "chat.activityCommands", count: 2 },
      { key: "chat.activitySearches", count: 1 },
      { key: "chat.activityThinking", count: 3 },
    ],
  );
});
