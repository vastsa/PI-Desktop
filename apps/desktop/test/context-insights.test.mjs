import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  contextHistoryMessages, contextHistoryGroups, contextRequests,
  contextTrendPoints, contextUsageSegments,
} = await import("../src/lib/context-insights.ts");

const message = (id, role, extra = {}) => ({ id, role, content: id, createdAt: "2026-10-21T10:00:00Z", ...extra });
const usage = (inputTokens, outputTokens = 0, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, totalTokens: inputTokens + outputTokens });
const system = (id, record, anchors = {}) => message(id, "system", {
  content: "", modelSystem: { version: 1, messageJson: JSON.stringify(record), ...anchors },
});

test("history reorders anchored declarations and excludes nested agents and duplicate system records", () => {
  const declaration = system("sys", { sections: { runtime: "Initial" } }, { beforeMessageId: "user" });
  const ordered = contextHistoryMessages([
    message("user", "user"), declaration, { ...declaration, id: "duplicate" },
    message("response", "assistant", { usage: usage(100) }),
    message("delegate", "assistant", { parentToolCallId: "task", usage: usage(999999) }),
    message("nested", "tool", { nestedParentToolCallId: "nested-task" }),
    system("update", { sections: { context: "New context" } }, { afterMessageId: "response" }),
  ]);
  assert.deepEqual(ordered.map(row => row.id), ["sys", "user", "response", "update"]);
  const requests = contextRequests(ordered);
  assert.equal(requests.length, 1);
  const groups = contextHistoryGroups(ordered.slice(0, requests[0].index));
  assert.equal(groups.find(group => group.category === "system").items[0].content, "Initial");
  assert.equal(groups.find(group => group.category === "injected").items.length, 0);
});

test("browser separates six recorded sources and keeps prior reasoning and tool input inspectable", () => {
  const groups = contextHistoryGroups([
    system("sys", { content: "Base", sections: { runtime: "Runtime", skills: "Skill notes", removed: null },
      toolsAdded: [{ name: "Read", description: "Read a file", parameters: { path: { type: "string" } } }] }),
    message("user", "user"), message("assistant", "assistant", { thinking: "Reasoning", content: "Reply" }),
    message("tool", "tool", { toolName: "Read", toolArgs: { path: "a.ts" }, toolResult: { content: "File body" }, toolUsage: { argumentTokens: 8, resultTokens: 12, totalTokens: 20, estimated: true } }),
  ]);
  assert.deepEqual(groups.map(group => group.category), ["system", "schemas", "user", "injected", "assistant", "tools"]);
  assert.deepEqual(groups.map(group => group.items.length), [2, 1, 1, 1, 1, 1]);
  assert.match(groups[1].items[0].content, /parameters/);
  assert.equal(groups[4].items[0].content, "Reasoning\n\nReply");
  assert.match(groups[5].items[0].content, /a.ts/);
  assert.equal(groups[5].tokens, 20);
});

test("legacy and malformed records remain unavailable instead of inventing a system prompt", () => {
  const groups = contextHistoryGroups([
    message("old", "user"),
    message("broken", "system", { modelSystem: { version: 1, messageJson: "broken" } }),
    system("null", null), system("shape", { sections: { runtime: 12 }, toolsAdded: [null, "tool", {}] }),
  ]);
  assert.equal(groups[0].tokens, 0);
  assert.equal(groups[1].tokens, 0);
  assert.equal(groups[2].items.length, 1);
});

test("trend uses each request's occupancy, retains negative changes, and does not sum a turn's cache", () => {
  const rows = [message("u1", "user"), message("a1", "assistant", { usage: usage(20, 10, 70) }),
    message("a2", "assistant", { usage: usage(30, 10, 160) }), message("u2", "user"),
    message("a3", "assistant", { usage: { ...usage(10, 10, 20), reasoningTokens: 5 } })];
  const mark = { id: "compact", generation: 1, throughMessageId: "u2", summaryTokens: 5, summarized: true };
  const requests = contextRequests(rows, [mark]);
  assert.deepEqual(requests.map(request => [request.turn, request.step]), [[1, 1], [1, 2], [2, 1]]);
  assert.equal(requests[2].compactions[0].id, "compact");
  assert.deepEqual(contextTrendPoints(requests, false).map(point => [point.total, point.delta]), [[100, 100], [200, 100], [40, -160]]);
  assert.deepEqual(contextTrendPoints(requests, true).map(point => point.total), [200, 40]);
  assert.equal(contextUsageSegments(rows.at(-1).usage).reduce((sum, segment) => sum + segment.tokens, 0), 40);
});

test("turn granularity preserves compaction markers on an earlier request in the turn", () => {
  const rows = [message("u", "user"), message("a", "assistant", { usage: usage(100) }), message("b", "assistant", { usage: usage(120) })];
  const mark = { id: "c", generation: 1, throughMessageId: "u", summaryTokens: 5, summarized: false };
  const points = contextTrendPoints(contextRequests(rows, [mark]), true);
  assert.equal(points.length, 1);
  assert.equal(points[0].request.message.id, "b");
  assert.equal(points[0].request.compactions[0].id, "c");
});

test("a partial history starts with a numbered turn and counts the next user as a new turn", () => {
  const requests = contextRequests([message("a", "assistant", { usage: usage(5) }), message("u", "user"), message("b", "assistant", { usage: usage(10) })]);
  assert.deepEqual(requests.map(request => request.turn), [1, 2]);
  assert.deepEqual(contextTrendPoints([], false), []);
  assert.equal(contextUsageSegments({ inputTokens: -5, outputTokens: NaN, cacheReadTokens: Infinity, totalTokens: 0 }).reduce((sum, segment) => sum + segment.tokens, 0), 0);
});
