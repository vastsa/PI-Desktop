import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { readStoreModule, readMainSource } from "./helpers/source-contracts.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { mergeLiveSessionMessages } = await import("../src/lib/session-transcript.ts");

test("deleteMessage merges the store read after the transcript reload, not a pre-await snapshot", async () => {
  const sliceSource = await readStoreModule("slices/transcript-slice.ts");

  // Contract (#1614): the merge must read get().messages AFTER the
  // loadFullSessionMessages await, so outputs that arrive during the reload
  // survive; a pre-await capture would erase them from view and persistence.
  assert.doesNotMatch(
    sliceSource,
    /deleteMessage:\s*async\s*\(messageId\)\s*=>\s*\{[\s\S]*?const\s+liveMessages\s*=\s*get\(\)\.messages;/,
    "deleteMessage must not capture a pre-await live snapshot",
  );
  assert.match(
    sliceSource,
    /deleteMessage:\s*async\s*\(messageId\)\s*=>\s*\{[\s\S]*?await\s+runtime\.loadFullSessionMessages\(sessionId\);[\s\S]*?mergeLiveSessionMessages\(fullMessages,\s*get\(\)\.messages\)/,
    "deleteMessage must merge fullMessages with the post-await store messages",
  );
  // A turn that started during the reload also bails: no rewrite under a
  // live stream.
  assert.match(
    sliceSource,
    /deleteMessage:\s*async\s*\(messageId\)\s*=>\s*\{[\s\S]*?get\(\)\.activeSessionId\s*!==\s*sessionId\s*\|\|\s*get\(\)\.isRunning/,
    "deleteMessage must re-check the session and isRunning after the await",
  );
});

test("sessionReplaceMessages IPC drops stale pending outbox appends for the session", async () => {
  const sessionIpcSource = await readMainSource("ipc/session-ipc.ts");

  assert.match(
    sessionIpcSource,
    /IPC\.invoke\.sessionReplaceMessages[\s\S]*?await\s+persistenceOutbox\.prepareSessionReplacement\(sessionId,\s*\(\)\s*=>\s*host\);[\s\S]*?return\s+host\.call\("session\.replaceMessages"/,
    "sessionReplaceMessages must drain in-flight appends before dropping the queue and replacing the transcript",
  );
});

test("mergeLiveSessionMessages preserves live AI outputs when backend disk is missing them, and only deleted turn is removed", () => {
  // Simulate backend host-core having only user messages persisted (e.g. outbox was pending or full)
  const durableMessages = [
    { id: "u1", role: "user", content: "first task", status: "complete" },
    { id: "u2", role: "user", content: "second task", status: "complete" },
    { id: "u3", role: "user", content: "third task", status: "complete" },
  ];

  // Live messages currently in renderer UI (containing streaming/completed AI outputs for all turns)
  const liveMessages = [
    { id: "u1", role: "user", content: "first task", status: "complete" },
    { id: "a1", role: "assistant", content: "first ai answer", status: "complete" },
    { id: "u2", role: "user", content: "second task", status: "complete" },
    { id: "t2", role: "tool", content: "tool result for second task", status: "complete" },
    { id: "a2", role: "assistant", content: "second ai answer", status: "complete" },
    { id: "u3", role: "user", content: "third task", status: "complete" },
    { id: "a3", role: "assistant", content: "third ai answer", status: "complete" },
  ];

  // 1. Merge must preserve all live AI outputs
  const merged = mergeLiveSessionMessages(durableMessages, liveMessages);
  assert.equal(merged.length, 7, "All 7 messages must be preserved after merging");

  // 2. Perform the exact deletion logic as deleteMessage on turn 2 ("u2")
  const index = merged.findIndex((m) => m.id === "u2");
  assert.equal(index, 2);

  let end = index + 1;
  while (end < merged.length && merged[end].role !== "user") {
    end += 1;
  }
  assert.equal(end, 5, "Turn 2 covers u2, t2, a2 (indices 2, 3, 4)");

  const next = [...merged.slice(0, index), ...merged.slice(end)];
  const nextIds = next.map((m) => m.id);

  // 3. Assert that turn 1 (u1, a1) and turn 3 (u3, a3) retain their complete user + AI messages!
  assert.deepEqual(nextIds, ["u1", "a1", "u3", "a3"]);
  assert.equal(next[0].role, "user");
  assert.equal(next[1].role, "assistant");
  assert.equal(next[2].role, "user");
  assert.equal(next[3].role, "assistant");
});

test("outputs that arrive during the full-transcript reload survive the delete merge", () => {
  // Durable transcript (host has the pre-tail state); the store already saw
  // the aborted turn's final output, which lands during the reload await.
  const durableAtLoadEnd = [
    { id: "u1", role: "user", content: "task", status: "complete" },
    { id: "u2", role: "user", content: "second task", status: "complete" },
    { id: "a2", role: "assistant", content: "second answer", status: "complete" },
  ];
  const storeAfterAwait = [
    ...durableAtLoadEnd,
    { id: "t2", role: "tool", content: "late tool_end for the aborted turn", status: "complete" },
  ];

  // The pre-await snapshot (#1614 bug shape) missed the late tool row:
  const staleMerged = mergeLiveSessionMessages(durableAtLoadEnd, durableAtLoadEnd.slice(0, 2));
  assert.ok(
    !staleMerged.some((m) => m.id === "t2"),
    "reproduces the bug shape: the stale snapshot drops the arriving output",
  );

  // The fix reads the store after the await, so the late output survives the
  // merge that feeds both the view and the persistence payload.
  const merged = mergeLiveSessionMessages(durableAtLoadEnd, storeAfterAwait);
  assert.ok(merged.some((m) => m.id === "t2"), "late-arriving output survives the merge");
});
