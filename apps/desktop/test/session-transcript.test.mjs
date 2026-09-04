import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeSessionMessages,
  mergeLiveSessionMessages,
  optimisticUserMessage,
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

test("repeated transcript rows keep one position and the latest value", () => {
  const first = message("user", { role: "user", content: "first" });
  const replacement = message("user", { role: "user", content: "latest" });
  const tail = message("answer", { content: "tail" });
  const tailReplacement = message("answer", { content: "latest tail" });
  const end = message("end", { content: "end" });
  const duplicate = [first, replacement, tail, tailReplacement, end];

  const normalized = dedupeSessionMessages(duplicate);
  assert.deepEqual(normalized.map(({ id, content }) => ({ id, content })), [
    { id: "user", content: "latest" },
    { id: "answer", content: "latest tail" },
    { id: "end", content: "end" },
  ]);
  const unique = [first, tail];
  assert.strictEqual(dedupeSessionMessages(unique), unique);
  assert.deepEqual(
    mergeLiveSessionMessages([first, tail], duplicate).map(({ id, content }) => ({
      id,
      content,
    })),
    [
      { id: "user", content: "first" },
      { id: "answer", content: "tail" },
      { id: "end", content: "end" },
    ],
  );
  assert.deepEqual(
    mergeLiveSessionMessages(duplicate, [first, tail]).map(({ id, content }) => ({
      id,
      content,
    })),
    [
      { id: "user", content: "latest" },
      { id: "answer", content: "latest tail" },
      { id: "end", content: "end" },
    ],
  );
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

test("optimistic user row carries the prompt and its file references under the renderer id (D288)", () => {
  const row = optimisticUserMessage(
    "11111111-2222-4333-8444-555555555555",
    "look at these",
    [
      { path: "/tmp/shot.png", name: "shot.png" },
      { path: "src/index.ts", name: "index.ts", kind: "file", mimeType: "text/plain" },
      { path: "/tmp/paste-1.txt", name: "paste-1.txt", token: "[paste #1]" },
    ],
    "2026-09-03T00:00:00.000Z",
  );
  assert.deepEqual(row, {
    id: "11111111-2222-4333-8444-555555555555",
    role: "user",
    content: "look at these",
    createdAt: "2026-09-03T00:00:00.000Z",
    status: "complete",
    attachments: [
      { kind: "image", name: "shot.png", ref: "/tmp/shot.png" },
      { kind: "file", name: "index.ts", ref: "src/index.ts", mimeType: "text/plain" },
    ],
  });
  assert.equal(
    "attachments" in optimisticUserMessage("id", "text only"),
    false,
    "a text-only prompt has no attachments key",
  );
});

test("host echo under the same id replaces the optimistic user row in place (D288)", () => {
  const optimistic = optimisticUserMessage("same-id", "/review src", [
    { path: "src/a.ts", name: "a.ts" },
  ]);
  const before = [message("earlier"), optimistic];
  const durable = message("same-id", {
    role: "user",
    content: "Review the code in src",
    command: "/review src",
    attachments: [{ kind: "file", name: "a.ts", ref: "sessions/x/a.ts" }],
  });
  const after = upsertLiveSessionMessage(before, durable);
  assert.equal(after.length, 2);
  assert.equal(after[1], durable);
  // A durable read that already holds the echo wins over the optimistic row;
  // one that does not yet hold it keeps the row visible.
  assert.deepEqual(mergeLiveSessionMessages([message("earlier"), durable], before), [
    message("earlier"),
    durable,
  ]);
  assert.deepEqual(mergeLiveSessionMessages([message("earlier")], before), before);
});
