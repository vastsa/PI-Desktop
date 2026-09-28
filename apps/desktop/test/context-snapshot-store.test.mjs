import assert from "node:assert/strict";
import test from "node:test";

const store = await import("../src/lib/context-snapshot-store.ts").catch(() => null);

function event(sessionId, at, overrides = {}) {
  return {
    sessionId,
    extensionId: "pi-context",
    key: "event:context:snapshot",
    text: JSON.stringify({
      at,
      modelId: "stub-1",
      modelName: "Stub",
      provider: "dev",
      contextWindow: 1000,
      totalTokens: 300,
      categories: [
        { key: "messages", label: "Messages", tokens: 300, percent: 30 },
        { key: "free", label: "Free", tokens: 700, percent: 70 },
      ],
      expanded: null,
      unknownTotal: false,
      ...overrides,
    }),
  };
}

test("a snapshot received while the panel is closed is replayed when it opens", () => {
  assert.ok(store, "the session snapshot store must exist");
  const id = "late-open-1";
  assert.equal(store.recordContextSnapshot(event(id, 10)), true);
  assert.equal(store.getContextSnapshot(id)?.at, 10);
  const updates = [];
  const off = store.subscribeContextSnapshots(() => updates.push(store.getContextSnapshot(id)?.at));
  store.recordContextSnapshot(event(id, 11));
  assert.deepEqual(updates, [11]);
  off();
  store.clearContextSnapshot(id);
});

test("invalid and older events cannot replace the current session's snapshot", () => {
  assert.ok(store);
  const a = "session-a";
  const b = "session-b";
  store.recordContextSnapshot(event(a, 20));
  store.recordContextSnapshot(event(b, 12));
  assert.equal(store.recordContextSnapshot(event(a, 19)), false);
  assert.equal(store.recordContextSnapshot({ ...event(a, 21), text: "bad-json" }), false);
  assert.equal(store.getContextSnapshot(a)?.at, 20);
  assert.equal(store.getContextSnapshot(b)?.at, 12);
  store.clearContextSnapshot(a);
  assert.equal(store.getContextSnapshot(a), null);
  assert.equal(store.getContextSnapshot(b)?.at, 12);
  store.clearContextSnapshot(b);
});

test("cache retains only the newest 32 sessions", () => {
  assert.ok(store);
  for (let i = 0; i < 33; i += 1) store.recordContextSnapshot(event(`bounded-${i}`, i));
  assert.equal(store.getContextSnapshot("bounded-0"), null);
  assert.equal(store.getContextSnapshot("bounded-32")?.at, 32);
  for (let i = 1; i < 33; i += 1) store.clearContextSnapshot(`bounded-${i}`);
});
