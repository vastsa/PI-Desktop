import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_SNAPSHOT_STATUS_KEY,
  fallbackContextSnapshot,
  parseContextSnapshotStatus,
} from "../src/lib/context-panel.ts";

test("Pi-Context status events are validated before entering renderer state", () => {
  const text = JSON.stringify({
    at: 42,
    modelId: "model-1",
    modelName: "Model One",
    provider: "provider",
    contextWindow: 1000,
    totalTokens: 300,
    categories: [
      { key: "messages", label: "Messages", tokens: 250, percent: 25 },
      { key: "free", label: "Free", tokens: 700, percent: 70 },
    ],
    expanded: null,
    unknownTotal: false,
  });

  assert.equal(CONTEXT_SNAPSHOT_STATUS_KEY, "event:context:snapshot");
  assert.deepEqual(parseContextSnapshotStatus(text), JSON.parse(text));
  assert.equal(parseContextSnapshotStatus("{}"), null);
  assert.equal(parseContextSnapshotStatus("not-json"), null);
});

test("session usage supplies a messages/free fallback before an extension snapshot", () => {
  const snapshot = fallbackContextSnapshot(
    {
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 10,
      totalTokens: 25,
    },
    100,
  );

  assert.equal(snapshot.contextWindow, 100);
  assert.equal(snapshot.totalTokens, 35);
  assert.deepEqual(
    snapshot.categories.map(({ key, tokens, percent }) => ({ key, tokens, percent })),
    [
      { key: "messages", tokens: 35, percent: 35 },
      { key: "free", tokens: 65, percent: 65 },
    ],
  );
});
