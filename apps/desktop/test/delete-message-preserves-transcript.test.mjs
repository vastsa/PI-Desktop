import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { readStoreModule, readMainSource } from "./helpers/source-contracts.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { mergeLiveSessionMessages } = await import("../src/lib/session-transcript.ts");

test("deleteMessage merges live in-memory messages before slicing out the deleted turn", async () => {
  const sliceSource = await readStoreModule("slices/transcript-slice.ts");

  // Contract: deleteMessage must capture current live messages and merge with fullMessages
  assert.match(
    sliceSource,
    /deleteMessage:\s*async\s*\(messageId\)\s*=>\s*\{[\s\S]*?const\s+liveMessages\s*=\s*get\(\)\.messages;/,
    "deleteMessage must read get().messages as liveMessages before overwriting",
  );
  assert.match(
    sliceSource,
    /mergeLiveSessionMessages\(fullMessages,\s*liveMessages\)/,
    "deleteMessage must merge fullMessages with liveMessages using mergeLiveSessionMessages",
  );
});

test("sessionReplaceMessages and sessionActivateRevision share one rewrite boundary with drain and guards", async () => {
  const sessionIpcSource = await readMainSource("ipc/session-ipc.ts");

  // The shared gate: refuse while a turn runs, serialize overlapping
  // operations, then drain the outbox before the callers' rewrite runs (#1612, #1613).
  assert.match(
    sessionIpcSource,
    /const\s+runTranscriptRewrite\s*=\s*async[\s\S]*?acquireSessionOperation\(sessionId\)[\s\S]*?activeTurns\.has\(sessionId\)[\s\S]*?AGENT_BUSY[\s\S]*?await\s+persistenceOutbox\.prepareSessionReplacement\(sessionId,[\s\S]*?finally\s*\{[\s\S]*?releaseSessionOperation\(\);/,
    "the rewrite gate must serialize per session, refuse running turns, and drain the outbox",
  );

  // Both rewrite entrances route through the gate — activation had no drain
  // before #1612, and overlapping replaces could interleave (#1613).
  assert.match(
    sessionIpcSource,
    /IPC\.invoke\.sessionReplaceMessages[\s\S]*?runTranscriptRewrite\(\s*sessionId,\s*"transcript replacement"[\s\S]*?session\.replaceMessages/,
    "sessionReplaceMessages must go through the shared rewrite gate",
  );
  assert.match(
    sessionIpcSource,
    /IPC\.invoke\.sessionActivateRevision[\s\S]*?runTranscriptRewrite\(\s*sessionId,\s*"revision activation"[\s\S]*?session\.activateRevision/,
    "sessionActivateRevision must go through the shared rewrite gate (it rewrites the same transcript rows)",
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
