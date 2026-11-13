import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { readSubagentIndexPage, readSubagentTranscriptPage,
  SUBAGENT_HISTORY_PAGE_SIZE, SUBAGENT_INDEX_SCAN_PAGES } =
  await import("../src/features/subagents/history.ts");

const row = (id, extra = {}) => ({
  id, role: "assistant", content: "", createdAt: "2026-11-01T00:00:00.000Z", ...extra,
});
const task = (id) => row(id, { role: "tool", toolName: "Task", toolCallId: id,
  toolArgs: { agent: "explorer", task: "Inspect", description: "Find it" },
  toolResult: { details: { delegationId: "del-" + id, status: "completed", report: "REPORT_NOT_IN_INDEX" } },
});
const page = (messages, start = 0, end = messages.length, more = false) => ({
  session: { id: "session-a", messages, messageStart: start, messageEnd: end,
    hasMoreBefore: more, hasMoreAfter: false },
});

test("index reads the requested session in bounded pages and keeps metadata only", async () => {
  const calls = [];
  const read = async (id, options) => {
    calls.push({ id, options });
    if (calls.length === 1) return page([row("child", { parentToolCallId: "old" })], 256, 512, true);
    return page([task("old"), row("answer", { parentToolCallId: "old" })], 0, 256);
  };
  const result = await readSubagentIndexPage(read, "session-a");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ id, options }) => id === "session-a" && options.messageLimit === SUBAGENT_HISTORY_PAGE_SIZE));
  assert.equal(calls[1].options.messageBefore, 256);
  assert.deepEqual(result.messages.map((message) => message.id), ["old"]);
  assert.equal(result.hasMore, false);
  assert.ok(!JSON.stringify(result).includes("REPORT_NOT_IN_INDEX"));
});

test("a scan budget never silently claims there are no older delegates", async () => {
  let calls = 0;
  const result = await readSubagentIndexPage(async () => {
    calls += 1;
    return page([row("child-" + calls, { parentToolCallId: "unloaded" })], 20_000 - calls * 256, 20_256 - calls * 256, true);
  }, "session-a");
  assert.equal(calls, SUBAGENT_INDEX_SCAN_PAGES);
  assert.equal(result.hasMore, true);
  assert.ok(result.before > 0);
});

test("missing sessions and invalid/non-advancing cursors remain observable errors", async () => {
  await assert.rejects(readSubagentIndexPage(async () => ({ session: null }), "session-a"));
  await assert.rejects(readSubagentIndexPage(async () => page([], 100, 200, true), "session-a", 100), /cursor/i);
});

test("aborted reads do not issue further Host requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(readSubagentIndexPage(async () => {
    calls += 1;
    controller.abort();
    return page([], 256, 512, true);
  }, "session-a", undefined, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("detail starts at the selected Task and advances independently of main transcript", async () => {
  const calls = [];
  const read = async (id, options) => {
    calls.push({ id, options });
    return { session: { id, messages: [task("own"),
      row("own-answer", { content: "Intermediate text", parentToolCallId: "own" }),
      task("foreign"), row("foreign-answer", { parentToolCallId: "foreign" })],
      messageStart: 0, messageEnd: 256, hasMoreAfter: true } };
  };
  const first = await readSubagentTranscriptPage(read, "session-a", ["own"]);
  assert.equal(calls[0].options.messageAround, "own");
  assert.deepEqual(first.messages.map((message) => message.id), ["own", "own-answer"]);
  assert.equal(first.hasMore, true);
  await readSubagentTranscriptPage(read, "session-a", ["own"], 100);
  assert.equal(calls[1].options.messageBefore, 100 + SUBAGENT_HISTORY_PAGE_SIZE);
  assert.equal(calls[1].id, "session-a");
});

test("resume detail accepts all own call ids, but no other chain's rows", async () => {
  const result = await readSubagentTranscriptPage(async () => page([
    task("first"), task("second"),
    row("first-answer", { parentToolCallId: "first" }),
    row("second-tool", { role: "tool", parentToolCallId: "second" }),
    row("other", { parentToolCallId: "another" }),
  ]), "session-a", ["first", "second"]);
  assert.deepEqual(result.messages.map((message) => message.id), ["first", "second", "first-answer", "second-tool"]);
});
