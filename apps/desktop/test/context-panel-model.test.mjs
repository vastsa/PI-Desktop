import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_SNAPSHOT_STATUS_KEY,
  parseContextSnapshotStatus,
} from "../src/lib/context-panel.ts";
import * as contextModel from "../src/lib/context-panel.ts";

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

test("fallback usage is an estimate, not a fabricated category breakdown", () => {
  assert.equal(typeof contextModel.contextCapacityView, "function");
  assert.equal("fallbackContextSnapshot" in contextModel, false);
  assert.deepEqual(contextModel.contextCapacityView(15, 128_000), {
    usedTokens: 15,
    remainingTokens: 127_985,
    contextWindow: 128_000,
    usedPercent: 15 / 128_000 * 100,
    percentLabel: "<1%",
  });
  assert.equal(contextModel.contextCapacityView(999, 1000).percentLabel, ">99%");
  assert.equal(contextModel.contextCapacityView(1000, 1000).percentLabel, "100%");
});

test("snapshot breakdown excludes Free and deferred tools from used-context bars", () => {
  assert.equal(typeof contextModel.contextSnapshotView, "function");
  const snapshot = parseContextSnapshotStatus(JSON.stringify({
    at: 20, modelId: "m", modelName: "Model", provider: "provider",
    contextWindow: 1000, totalTokens: 400, unknownTotal: false, expanded: null,
    categories: [
      { key: "messages", label: "Messages", tokens: 300, percent: 30 },
      { key: "systemPrompt", label: "System prompt", tokens: 100, percent: 10 },
      { key: "skills", label: "Skills", tokens: 0, percent: 0 },
      { key: "mcpDeferred", label: "MCP deferred", tokens: 150, percent: 15, deferred: true, count: 2 },
      { key: "free", label: "Free", tokens: 600, percent: 60 },
    ],
  }));
  assert.ok(snapshot);
  const view = contextModel.contextSnapshotView(snapshot);
  assert.equal(view.capacity.remainingTokens, 600);
  assert.deepEqual(view.active.map((row) => [row.key, row.shareLabel]), [
    ["messages", "75%"],
    ["systemPrompt", "25%"],
  ]);
  assert.deepEqual(view.inactive.map((row) => row.key), ["skills"]);
  assert.deepEqual(view.deferred.map((row) => row.key), ["mcpDeferred"]);
});

test("system prompt details are nested rather than double-counted as top-level usage", () => {
  const snapshot = parseContextSnapshotStatus(JSON.stringify({
    at: 21, modelId: "m", modelName: "Model", provider: "provider",
    contextWindow: 1000, totalTokens: 400, unknownTotal: false, expanded: null,
    categories: [
      { key: "messages", label: "Messages", tokens: 300, percent: 30 },
      { key: "systemPrompt", label: "System prompt", tokens: 100, percent: 10 },
      { key: "skills", label: "Skills", tokens: 50, percent: 5 },
      { key: "mcpTools", label: "MCP tools", tokens: 25, percent: 2.5 },
      { key: "memoryFiles", label: "Memory files", tokens: 0, percent: 0 },
      { key: "free", label: "Free", tokens: 600, percent: 60 },
    ],
  }));
  assert.ok(snapshot);
  const view = contextModel.contextSnapshotView(snapshot);
  assert.equal(view.categoryEstimateTokens, 400);
  assert.deepEqual(view.active.map((row) => [row.key, row.shareLabel]), [
    ["messages", "75%"],
    ["systemPrompt", "25%"],
  ]);
  assert.deepEqual(view.systemDetails.map((row) => [row.key, row.shareLabel]), [
    ["skills", "50%"],
    ["mcpTools", "25%"],
  ]);
});

test("estimated category composition remains honest when reported usage differs", () => {
  const snapshot = parseContextSnapshotStatus(JSON.stringify({
    at: 22, modelId: "m", modelName: "Model", provider: "provider",
    contextWindow: 1000, totalTokens: 15, unknownTotal: false, expanded: null,
    categories: [
      { key: "messages", label: "Messages", tokens: 300, percent: 30 },
      { key: "systemPrompt", label: "System prompt", tokens: 100, percent: 10 },
      { key: "free", label: "Free", tokens: 985, percent: 98.5 },
    ],
  }));
  assert.ok(snapshot);
  const view = contextModel.contextSnapshotView(snapshot);
  assert.equal(view.capacity.usedTokens, 15);
  assert.equal(view.categoryEstimateTokens, 400);
  assert.equal(view.estimateMismatch, true);
  assert.deepEqual(view.active.map((row) => row.shareLabel), ["75%", "25%"]);
});
