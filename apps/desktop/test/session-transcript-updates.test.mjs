import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  getSessionMessageSnapshot,
  getSessionToolMessagePositions,
  SESSION_MESSAGE_BLOCK_SIZE,
} = await import("../src/lib/session-transcript-updates.ts");
const {
  dedupeSessionMessages,
  projectMessageEnd,
  reconcilePersistedUserMessage,
  removeLiveSessionMessage,
  upsertLiveSessionMessage,
} = await import("../src/lib/session-transcript.ts");

const message = (id, overrides = {}) => ({
  id,
  role: "assistant",
  content: id,
  createdAt: "2026-09-30T00:00:00Z",
  ...overrides,
});
const history = (length) => Array.from({ length }, (_, index) => message(`row-${index}`));

test("warm replacements and dedupe do not read historical message ids", () => {
  let historicalIdReads = 0;
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    ...message(`old-${index}`),
    get id() { historicalIdReads++; return `old-${index}`; },
  }));
  rows.push(message("tail", { status: "streaming" }));
  const first = getSessionMessageSnapshot(rows);
  historicalIdReads = 0;
  let current = rows;
  for (let index = 0; index < 20; index++) {
    current = upsertLiveSessionMessage(current, message("tail", { content: `token ${index}` }));
    assert.equal(dedupeSessionMessages(current), current);
  }
  const latest = getSessionMessageSnapshot(current);
  assert.equal(historicalIdReads, 0);
  assert.equal(latest.owner, first.owner);
  assert.equal(latest.generation, first.generation + 20);
  assert.equal(latest.positions, first.positions);
  assert.equal(latest.blocks[0], first.blocks[0]);
  assert.equal(rows.at(-1).content, "tail", "published source array is not mutated");
});

test("immutable blocks retain every changed region across skipped or branched generations", () => {
  const rows = history(SESSION_MESSAGE_BLOCK_SIZE * 4);
  const first = getSessionMessageSnapshot(rows);
  const changedEarly = upsertLiveSessionMessage(rows, message("row-3", { content: "early" }));
  const second = getSessionMessageSnapshot(changedEarly);
  const changedLate = upsertLiveSessionMessage(changedEarly, message("row-130", { content: "late" }));
  const third = getSessionMessageSnapshot(changedLate);
  assert.equal(third.owner, first.owner);
  assert.equal(third.generation, first.generation + 2);
  assert.notEqual(third.blocks[0], first.blocks[0]);
  assert.equal(third.blocks[0], second.blocks[0]);
  assert.equal(third.blocks[1], first.blocks[1]);
  assert.notEqual(third.blocks[2], first.blocks[2]);
  assert.equal(third.blocks[3], first.blocks[3]);
  assert.equal(first.blocks[0][3].content, "row-3");
  assert.equal(second.blocks[2][2].content, "row-130");
  assert.equal(getSessionMessageSnapshot(rows), first);

  const abandonedBranch = upsertLiveSessionMessage(rows, message("row-65", { content: "branch" }));
  const branch = getSessionMessageSnapshot(abandonedBranch);
  assert.equal(branch.blocks[0], first.blocks[0]);
  assert.notEqual(branch.blocks[1], first.blocks[1]);
  assert.equal(branch.blocks[2], first.blocks[2]);
  assert.equal(third.blocks[1][1].content, "row-65");
});

test("unknown arrays validate once and receive independent owners", () => {
  let reads = 0;
  const rows = [{ ...message("id"), get id() { reads++; return "id"; } }];
  const snapshot = getSessionMessageSnapshot(rows);
  assert.equal(getSessionMessageSnapshot(rows), snapshot);
  assert.equal(dedupeSessionMessages(rows), rows);
  assert.equal(reads, 1);
  const copy = rows.slice();
  assert.notEqual(getSessionMessageSnapshot(copy).owner, snapshot.owner);
  assert.equal(reads, 2);
  const reordered = history(3).reverse();
  assert.equal(getSessionMessageSnapshot(reordered).positions.get("row-2"), 0);
});

test("duplicates keep first position, last value and become a tracked unique array", () => {
  const rows = [message("a"), message("b"), message("a", { content: "last a" }), message("c"), message("b", { content: "last b" })];
  const source = getSessionMessageSnapshot(rows);
  assert.equal(source.unique, false);
  assert.equal(source.positions.get("a"), 0);
  const normalized = dedupeSessionMessages(rows);
  assert.deepEqual(normalized.map((row) => row.content), ["last a", "last b", "c"]);
  const next = getSessionMessageSnapshot(normalized);
  assert.equal(next.unique, true);
  assert.equal(next.owner, source.owner);
  assert.equal(next.positions.get("c"), 2);
  assert.equal(source.positions.get("c"), 3, "normalization never mutates the published index");
  const updated = upsertLiveSessionMessage(rows, message("b", { content: "updated b" }));
  assert.deepEqual(updated.map((row) => row.content), ["last a", "updated b", "c"]);
});

test("append, removal, native rekey and optimistic acknowledgement refresh indexes safely", () => {
  const rows = history(SESSION_MESSAGE_BLOCK_SIZE);
  const before = getSessionMessageSnapshot(rows);
  const appended = upsertLiveSessionMessage(rows, message("provisional", { status: "streaming" }));
  const after = getSessionMessageSnapshot(appended);
  assert.equal(after.owner, before.owner);
  assert.equal(after.blocks[0], before.blocks[0]);
  assert.notEqual(after.positions, before.positions);
  assert.equal(before.positions.has("provisional"), false);
  const terminal = message("durable", { status: "complete" });
  const rekeyed = projectMessageEnd(appended, { type: "message_end", replacesMessageId: "provisional", message: terminal });
  assert.equal(rekeyed.at(-1), terminal);
  const rekeyedSnapshot = getSessionMessageSnapshot(rekeyed);
  assert.equal(rekeyedSnapshot.owner, before.owner);
  assert.equal(rekeyedSnapshot.positions.has("provisional"), false);
  assert.equal(rekeyedSnapshot.positions.get("durable"), SESSION_MESSAGE_BLOCK_SIZE);
  assert.equal(after.positions.has("provisional"), true);
  const removed = removeLiveSessionMessage(rekeyed, "row-3");
  assert.equal(getSessionMessageSnapshot(removed).positions.get("row-4"), 3);
  assert.equal(rekeyedSnapshot.positions.get("row-4"), 4);

  const optimistic = [message("o", { role: "user" }), message("other"), message("ack", { role: "user" })];
  const acknowledged = message("ack", { role: "user", content: "acknowledged" });
  const result = reconcilePersistedUserMessage(optimistic, "o", acknowledged);
  assert.deepEqual(result.map((row) => row.id), ["ack", "other"]);
  assert.equal(result[0], acknowledged);
  assert.equal(getSessionMessageSnapshot(result).unique, true);
});

test("tool-call positions follow same-id rekeys, role/status changes and structural edits immutably", () => {
  const rows = [
    message("first", { role: "tool", toolCallId: "a", toolStatus: "running" }),
    message("second", { role: "tool", toolCallId: "b", toolStatus: "running" }),
    message("third", { role: "assistant", toolCallId: "a", toolStatus: "success" }),
  ];
  const original = getSessionToolMessagePositions(rows, "a");
  assert.deepEqual(original, [0, 2]);
  const rekeyed = upsertLiveSessionMessage(rows, { ...rows[0], toolCallId: "b" });
  assert.deepEqual(getSessionToolMessagePositions(rekeyed, "a"), [2]);
  assert.deepEqual(getSessionToolMessagePositions(rekeyed, "b"), [0, 1]);
  assert.deepEqual(original, [0, 2]);
  assert.deepEqual(getSessionToolMessagePositions(rows, "b"), [1]);
  assert.throws(() => original.push(9), TypeError, "callers cannot mutate a published position list");

  const changedRole = upsertLiveSessionMessage(rekeyed, { ...rekeyed[0], role: "user", toolStatus: "success" });
  assert.deepEqual(getSessionToolMessagePositions(changedRole, "b"), [0, 1], "the event predicate is role independent");
  const removedCall = upsertLiveSessionMessage(changedRole, { ...changedRole[0], toolCallId: undefined });
  assert.deepEqual(getSessionToolMessagePositions(removedCall, "b"), [1]);
  const appended = upsertLiveSessionMessage(removedCall, message("last", { toolCallId: "b" }));
  assert.deepEqual(getSessionToolMessagePositions(appended, "b"), [1, 3]);
  assert.deepEqual(getSessionToolMessagePositions(removedCall, "b"), [1]);
  const shortened = removeLiveSessionMessage(appended, "first");
  assert.deepEqual(getSessionToolMessagePositions(shortened, "b"), [0, 2]);
  const unknown = [shortened[2], shortened[0]];
  assert.deepEqual(getSessionToolMessagePositions(unknown, "b"), [0, 1]);
});
