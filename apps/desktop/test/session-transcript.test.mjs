import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeLiveSessionMessages,
  removeLiveSessionMessage,
  upsertLiveSessionMessage,
} from "../src/lib/session-transcript.ts";

const message = (id, overrides = {}) => ({
  id,
  role: "assistant",
  content: id,
  createdAt: "2026-08-31T00:00:00.000Z",
  ...overrides,
});

test("durable reads keep a live assistant tail that is not persisted yet", () => {
  const durable = [message("user", { role: "user", content: "prompt" })];
  const live = [
    ...durable,
    message("answer", { content: "partial", status: "streaming" }),
  ];

  assert.deepEqual(
    mergeLiveSessionMessages(durable, live).map(({ id, content }) => ({ id, content })),
    [
      { id: "user", content: "prompt" },
      { id: "answer", content: "partial" },
    ],
  );
});

test("a durable completed row remains authoritative over a stale live copy", () => {
  const durable = [message("answer", { content: "final", status: "complete" })];
  const live = [message("answer", { content: "partial", status: "complete" })];

  assert.strictEqual(mergeLiveSessionMessages(durable, live), durable);
});

test("live-only terminal rows are retained when detail arrives during a turn", () => {
  const durable = [message("user", { role: "user", content: "prompt" })];
  const live = [
    ...durable,
    message("answer", { content: "final", status: "complete" }),
  ];

  assert.equal(mergeLiveSessionMessages(durable, live).at(-1).id, "answer");
});

test("live event upserts preserve array identity for unchanged rows", () => {
  const original = [message("answer", { status: "streaming" })];
  const updated = upsertLiveSessionMessage(original, {
    ...original[0],
    content: "new partial",
  });

  assert.notStrictEqual(updated, original);
  assert.equal(updated[0].content, "new partial");
  assert.strictEqual(upsertLiveSessionMessage(original, original[0]), original);
  assert.strictEqual(removeLiveSessionMessage(original, "missing"), original);
});
