import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { getTranscriptProjection } = await import("../src/lib/transcript-projection.ts");
const { upsertLiveSessionMessage } = await import("../src/lib/session-transcript.ts");
const { latestTurnContextInspector } = await import("../src/lib/latest-turn-context.ts");
const { buildConversationMinimapMarkers } = await import("../src/lib/conversation-minimap.ts");

const usage = { inputTokens: 20, outputTokens: 5, totalTokens: 25 };
const message = (id, role, content, extra = {}) => ({
  id, role, content, createdAt: "2026-09-30T00:00:00.000Z", ...extra,
});

function assertProjection(messages, compactions) {
  const actual = getTranscriptProjection(messages, compactions);
  const expected = buildTranscriptEntries(messages, compactions);
  assert.deepEqual(actual.entries, expected.entries);
  assert.deepEqual(actual.visible, expected.visible);
  assert.deepEqual(actual.history, expected.entries.slice(0, -1));
  return actual;
}

for (const count of [100, 1_000, 10_784]) {
  test(`${count} loaded messages: one tail delta does not read historical content`, () => {
    let reads = 0;
    let messages = Array.from({ length: count - 1 }, (_, index) => {
      const row = message(`m-${index}`, index % 2 ? "assistant" : "user", "", index % 2 ? { usage } : {});
      Object.defineProperty(row, "content", {
        enumerable: true,
        get() { reads++; return "Synthetic historical content. ".repeat(36); },
      });
      return row;
    });
    messages.push(message("tail", "assistant", "Live", { status: "streaming" }));
    const before = getTranscriptProjection(messages);
    const inspector = latestTurnContextInspector(messages, {}, []);
    buildConversationMinimapMarkers(before.visible);
    messages = upsertLiveSessionMessage(messages, { ...messages.at(-1), content: "Live delta" });
    reads = 0;
    const after = getTranscriptProjection(messages);
    const nextInspector = latestTurnContextInspector(messages, {}, []);
    buildConversationMinimapMarkers(after.visible);
    assert.equal(reads, 0, "completed content must stay out of the update path");
    assert.equal(after.history, before.history);
    assert.equal(nextInspector, inspector, "unchanged context statistics retain their identity");
    assertProjection(messages);
  });
}

test("the first tool output does not rebuild unrelated completed history", () => {
  let reads = 0;
  let messages = Array.from({ length: 1_000 }, (_, index) => {
    const row = message(`m-${index}`, index % 2 ? "assistant" : "user", "");
    Object.defineProperty(row, "content", {
      enumerable: true, get() { reads++; return "Completed content"; },
    });
    return row;
  });
  messages.push(message("tool", "tool", "", { toolName: "Bash", toolCallId: "tool", toolStatus: "running" }));
  const before = getTranscriptProjection(messages);
  messages = upsertLiveSessionMessage(messages, { ...messages.at(-1), content: "First output", toolResult: "First output" });
  reads = 0;
  const after = getTranscriptProjection(messages);
  assert.equal(reads, 0);
  assert.equal(after.history, before.history);
  assertProjection(messages);
});

test("one giant turn preserves completed activity parts and old snapshots", () => {
  let messages = [message("user", "user", "Work")];
  for (let index = 0; index < 300; index++) {
    messages.push(message(`tool-${index}`, "tool", "result", { toolName: "Read", toolCallId: `tool-${index}` }));
    messages.push(message(`answer-${index}`, "assistant", `Answer ${index}`, { usage }));
  }
  messages.push(message("tail", "assistant", "Live", { thinking: "Plan", status: "streaming" }));
  const before = assertProjection(messages);
  const oldSource = messages;
  messages = upsertLiveSessionMessage(messages, { ...messages.at(-1), thinking: "Plan more", content: "Live more" });
  const after = assertProjection(messages);
  assert.equal(after.entries[1].parts[0], before.entries[1].parts[0]);
  assert.equal(before.entries[1].parts.at(-1).message.content, "Live");
  assert.equal(after.entries[1].parts.at(-1).message.content, "Live more");
  assert.equal(getTranscriptProjection(oldSource), before);
});

test("skipped generations and old deferred reads preserve every changed row", () => {
  let messages = [message("u", "user", "Work"), ...Array.from({ length: 160 }, (_, index) => message(`a-${index}`, "assistant", `Answer ${index}`))];
  const original = messages;
  const first = assertProjection(messages);
  const middle = upsertLiveSessionMessage(messages, { ...messages[3], content: "Changed early" });
  messages = upsertLiveSessionMessage(middle, { ...middle[130], content: "Changed later" });
  const newest = assertProjection(messages);
  assertProjection(middle);
  assert.equal(getTranscriptProjection(original), first);
  assert.equal(getTranscriptProjection(messages), newest);
  messages = upsertLiveSessionMessage(messages, { ...messages.at(-1), content: "Tail" });
  assertProjection(messages);
});

test("interleaved delegate text patches every answer/thinking slot, not a guessed tail", () => {
  let messages = [
    message("u", "user", "Run delegates"),
    message("task", "tool", "running", { toolName: "Task", toolCallId: "call", toolArgs: {}, toolResult: {} }),
    message("child", "assistant", "Child answer", { parentToolCallId: "call", agentName: "worker", thinking: "Child reasoning" }),
    message("parent", "assistant", "Parent answer"),
  ];
  const before = assertProjection(messages);
  messages = upsertLiveSessionMessage(messages, { ...messages[2], content: "Child answer updated", thinking: "Child reasoning updated" });
  const after = assertProjection(messages);
  const items = after.entries[1].parts[0].items[0].delegate.items;
  assert.equal(items[0].message, messages[2]);
  assert.equal(items[1].message, messages[2]);
  assert.equal(after.entries[1].parts[1], before.entries[1].parts[1]);
  assert.equal(before.entries[1].parts[0].items[0].delegate.items[1].message.content, "Child answer");
});

test("structural visibility, compaction, resume, rewrite and duplicate inputs match full grouping", () => {
  let messages = [message("u", "user", "Work"), message("a", "assistant", "", { thinking: "Reason" })];
  const compactions = [{ id: "compact", throughMessageId: "a", generation: 1, summaryTokens: 10, summarized: true }];
  assertProjection(messages);
  for (const change of [
    { content: "First text" }, { thinking: "" }, { content: "  " },
    { error: { code: "FAILED", message: "Failed" } }, { content: "Recovered", error: undefined },
  ]) {
    messages = upsertLiveSessionMessage(messages, { ...messages[1], ...change });
    assertProjection(messages);
    assertProjection(messages, compactions);
  }
  messages = upsertLiveSessionMessage(messages, message("task-1", "tool", "done", {
    toolName: "Task", toolCallId: "call-1", toolResult: { details: { delegationId: "delegate" } },
  }));
  messages = upsertLiveSessionMessage(messages, message("child", "assistant", "Report", { parentToolCallId: "call-1" }));
  assertProjection(messages);
  messages = upsertLiveSessionMessage(messages, message("task-2", "tool", "done", {
    toolName: "Task", toolCallId: "call-2", toolArgs: { resume: "delegate" },
  }));
  assertProjection(messages);
  messages = upsertLiveSessionMessage(messages, { ...messages.at(-1), toolArgs: {} });
  assertProjection(messages);
  assertProjection([message("older", "user", "Older"), ...messages]);
  assertProjection(messages.slice(2));
  assertProjection([...messages, { ...messages[1], content: "Duplicate" }]);
});

test("deterministic replacement sequences match grouping after each update", () => {
  let messages = [message("u", "user", "Work")];
  for (let index = 0; index < 80; index++) {
    messages.push(message(`a-${index}`, "assistant", `Text ${index}`, { thinking: index % 2 ? "Reason" : "", usage }));
    messages.push(message(`tool-${index}`, "tool", "Result", { toolName: "Read", toolCallId: `tool-${index}` }));
  }
  assertProjection(messages);
  for (let step = 0; step < 100; step++) {
    const index = 1 + ((step * 37) % (messages.length - 1));
    messages = upsertLiveSessionMessage(messages, {
      ...messages[index], content: `Replacement ${step}`,
      ...(step % 11 === 0 ? { thinking: "New reasoning" } : {}),
    });
    assertProjection(messages);
  }
});

test("a saturated minimap preview ignores later huge fragments but keeps user boundaries", () => {
  let reads = 0;
  const later = message("later", "assistant", "");
  Object.defineProperty(later, "content", { get() { reads++; return "x".repeat(100_000); } });
  const markers = buildConversationMinimapMarkers([
    message("u", "user", "Question"), message("first", "assistant", "a".repeat(280)),
    later, message("system", "system", "Boundary"), message("after-system", "assistant", "Same marker"),
    message("u2", "user", "Next"), message("a2", "assistant", "Second answer"),
  ]);
  assert.equal(reads, 0);
  assert.deepEqual(markers.map(({ id }) => id), ["u", "first", "u2", "a2"]);
});
