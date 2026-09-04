import assert from "node:assert/strict";
import test from "node:test";

import {
  InflightCheckpointer,
  isCheckpointableMessage,
} from "../electron/main/inflight-checkpoint.ts";

const assistant = (id, content, thinking) => ({
  id,
  role: "assistant",
  content,
  thinking,
  createdAt: "2026-09-04T00:00:00.000Z",
  status: "streaming",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("only assistant messages with visible text are checkpointable", () => {
  assert.equal(isCheckpointableMessage(assistant("a", "hello")), true);
  assert.equal(isCheckpointableMessage(assistant("a", "", "thinking")), true);
  assert.equal(isCheckpointableMessage(assistant("a", "  ", "  ")), false);
  assert.equal(
    isCheckpointableMessage({ ...assistant("a", "hello"), role: "user" }),
    false,
  );
});

test("first snapshot is written immediately and a burst collapses to one trailing write", async () => {
  const saved = [];
  const checkpointer = new InflightCheckpointer(async (checkpoint) => {
    saved.push(checkpoint.message.content);
  }, 30);

  checkpointer.observe({ sessionId: "s", turnId: "t", message: assistant("a", "h") });
  await sleep(0);
  assert.deepEqual(saved, ["h"]);

  checkpointer.observe({ sessionId: "s", turnId: "t", message: assistant("a", "he") });
  checkpointer.observe({ sessionId: "s", turnId: "t", message: assistant("a", "hel") });
  checkpointer.observe({ sessionId: "s", turnId: "t", message: assistant("a", "hell") });
  assert.deepEqual(saved, ["h"], "throttled inside the interval");

  await sleep(60);
  assert.deepEqual(saved, ["h", "hell"], "newest snapshot wins the trailing write");
  checkpointer.dispose();
});

test("settle drops the pending snapshot once the final row is on its way", async () => {
  const saved = [];
  const checkpointer = new InflightCheckpointer(async (checkpoint) => {
    saved.push(checkpoint.message.content);
  }, 30);

  checkpointer.observe({ sessionId: "s", message: assistant("a", "h") });
  await sleep(0);
  checkpointer.observe({ sessionId: "s", message: assistant("a", "he") });
  checkpointer.settle("s");
  await sleep(60);
  assert.deepEqual(saved, ["h"]);
  assert.deepEqual(checkpointer.pendingSessions(), []);
  checkpointer.dispose();
});

test("flushAll writes every pending session without waiting for the interval", async () => {
  const saved = [];
  const checkpointer = new InflightCheckpointer(async (checkpoint) => {
    saved.push(`${checkpoint.sessionId}:${checkpoint.message.content}`);
  }, 10_000);

  checkpointer.observe({ sessionId: "a", message: assistant("m1", "one") });
  checkpointer.observe({ sessionId: "b", message: assistant("m2", "two") });
  await sleep(0);
  checkpointer.observe({ sessionId: "a", message: assistant("m1", "one more") });
  checkpointer.observe({ sessionId: "b", message: assistant("m2", "two more") });
  assert.deepEqual(checkpointer.pendingSessions().sort(), ["a", "b"]);

  await checkpointer.flushAll();
  assert.deepEqual(saved, ["a:one", "b:two", "a:one more", "b:two more"]);
  assert.deepEqual(checkpointer.pendingSessions(), []);
  checkpointer.dispose();
});

test("a failing save does not wedge later checkpoints", async () => {
  let fail = true;
  const saved = [];
  const checkpointer = new InflightCheckpointer(async (checkpoint) => {
    if (fail) throw new Error("host unavailable");
    saved.push(checkpoint.message.content);
  }, 10);

  checkpointer.observe({ sessionId: "s", message: assistant("a", "h") });
  await sleep(0);
  fail = false;
  checkpointer.observe({ sessionId: "s", message: assistant("a", "he") });
  await sleep(40);
  assert.deepEqual(saved, ["he"]);
  checkpointer.dispose();
});

test("delegate rows are the caller's decision: the checkpointer keys by session only", async () => {
  const saved = [];
  const checkpointer = new InflightCheckpointer(async (checkpoint) => {
    saved.push(checkpoint.message.id);
  }, 10_000);
  checkpointer.observe({ sessionId: "s", message: assistant("parent", "p") });
  await sleep(0);
  checkpointer.observe({ sessionId: "s", message: assistant("child", "c") });
  await checkpointer.flushAll();
  assert.deepEqual(saved, ["parent", "child"]);
  checkpointer.dispose();
});
