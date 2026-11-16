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

test("compacted context uses the checkpoint model after the historical model is retired (#2164)", () => {
  const historicalUsage = { inputTokens: 480_000, outputTokens: 2_238, totalTokens: 482_238 };
  const messages = [message("a1", "assistant", { providerId: "p", modelId: "retired", usage: historicalUsage })];
  const configured = [{ id: "p", models: [{ id: "current", contextWindow: 1_000_000 }] }];
  const checkpoint = mark("a1", { contextTokens: 20_619, providerId: "p", modelId: "current" });
  const inspector = latestTurnContextInspector(messages, {}, configured, [checkpoint], { providerId: "p", modelId: "current" });
  assert.equal(inspector.contextWindow, 1_000_000);
  assert.equal(composerContextUsage(inspector).usedPercent, 2);
  assert.equal(inspector.usage, historicalUsage);
});

test("legacy compactions can use the current exact model while request usage keeps its model", () => {
  const messages = [message("a1", "assistant", { providerId: "p", modelId: "m", usage })];
  const configured = [{ id: "p", models: [{ id: "m", contextWindow: 100_000 }, { id: "current", contextWindow: 1_000_000 }] }];
  const current = { providerId: "p", modelId: "current" };
  const before = latestTurnContextInspector(messages, {}, configured, [], current);
  assert.equal(before.contextWindow, 100_000);
  const after = latestTurnContextInspector(messages, {}, configured, [mark("a1", { contextTokens: 20_619 })], current);
  assert.equal(after.contextWindow, 1_000_000);
  assert.equal(after.usage, usage);
});

test("unknown compacted model capacity remains an explicit estimate without borrowing another route", () => {
  const messages = [message("a1", "assistant", { providerId: "p", modelId: "tenant/missing", usage })];
  const configured = [{ id: "p", models: [{ id: "missing", contextWindow: 1_000_000 }] }];
  const inspector = latestTurnContextInspector(messages, {}, configured, [mark("a1", { contextTokens: 20_619 })], { providerId: "p", modelId: "tenant/missing" });
  assert.equal(inspector.contextWindow, 128_000);
  assert.equal(inspector.contextWindowEstimated, true);
});
