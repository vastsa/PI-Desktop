import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { latestTurnContextInspector } = await import("../src/lib/latest-turn-context.ts");
const { composerContextUsage } = await import("../src/lib/context-usage.ts");

// The last request before /compact filled most of a 100k window.
const usage = { inputTokens: 80_000, outputTokens: 2_000, totalTokens: 82_000 };
const providers = [{ id: "p", models: [{ id: "m", contextWindow: 100_000 }] }];
const message = (id, role, extra = {}) => ({
  id,
  role,
  content: role === "user" ? "question" : "answer",
  createdAt: "2026-10-31T00:00:00.000Z",
  status: "complete",
  ...extra,
});
const mark = (throughMessageId, extra = {}) => ({
  id: `checkpoint-${throughMessageId}`,
  throughMessageId,
  generation: 1,
  summaryTokens: 900,
  summarized: true,
  ...extra,
});

function inspect(messages, compactions) {
  return latestTurnContextInspector(messages, {}, providers, compactions);
}

test("the composer reflects a finished compaction before the next request (#2015)", () => {
  const messages = [
    message("u1", "user"),
    message("a1", "assistant", { providerId: "p", modelId: "m", usage }),
  ];
  const before = inspect(messages, []);
  assert.equal(composerContextUsage(before).usedPercent, 82);

  const after = inspect(messages, [mark("a1", { contextTokens: 12_000 })]);
  assert.equal(after.compactedContextTokens, 12_000);
  assert.equal(composerContextUsage(after).usedPercent, 12);
  // The provider breakdown still describes the last real request.
  assert.equal(after.usage, usage);
});

test("a request after the compaction reports real usage again", () => {
  const nextUsage = { inputTokens: 15_000, outputTokens: 1_000, totalTokens: 16_000 };
  const messages = [
    message("u1", "user"),
    message("a1", "assistant", { providerId: "p", modelId: "m", usage }),
    message("u2", "user"),
    message("a2", "assistant", { providerId: "p", modelId: "m", usage: nextUsage }),
  ];
  const inspector = inspect(messages, [mark("a1", { contextTokens: 12_000 })]);
  assert.equal(inspector.compactedContextTokens, undefined);
  assert.equal(composerContextUsage(inspector).usedPercent, 16);
});

test("checkpoints without an estimate keep the previous behavior", () => {
  const messages = [
    message("u1", "user"),
    message("a1", "assistant", { providerId: "p", modelId: "m", usage }),
  ];
  const inspector = inspect(messages, [mark("a1")]);
  assert.equal(inspector.compactedContextTokens, undefined);
  assert.equal(composerContextUsage(inspector).usedPercent, 82);
});

test("a compaction anchored on a message the transcript does not hold is ignored", () => {
  const messages = [
    message("u1", "user"),
    message("a1", "assistant", { providerId: "p", modelId: "m", usage }),
  ];
  const inspector = inspect(messages, [mark("missing", { contextTokens: 12_000 })]);
  assert.equal(inspector.compactedContextTokens, undefined);
});
