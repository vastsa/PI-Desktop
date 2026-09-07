import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateToolTokenUsage,
  calculateCacheRate,
  calculateTokenRate,
  calculateContextUsage,
  estimateResponseOutputTokens,
  estimateToolTokenUsage,
  resolveContextWindow,
  toolTokenUsage,
  usageTokenTotal,
  settleStoppedAssistantMetrics,
} from "../src/lib/context-usage.ts";

test("context usage exposes the remaining ring percentage", () => {
  const context = calculateContextUsage(
    {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    },
    128,
  );

  assert.equal(context.usedTokens, 100);
  assert.equal(context.remainingTokens, 28);
  assert.equal(context.usedPercent, 78);
  assert.equal(context.remainingPercent, 22);
  assert.equal(context.remainingRatio, 28 / 128);
});

test("context window prefers the selected model catalog over provider fallback", () => {
  const providerModels = {
    provider: [
      {
        modelId: "catalog-model",
        displayName: "Catalog model",
        providerId: "provider",
        contextWindow: 256_000,
        capabilities: ["text"],
        source: "discovered",
      },
      {
        modelId: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        providerId: "provider",
        contextWindow: 1_050_000,
        capabilities: ["text"],
        source: "discovered",
      },
    ],
  };
  const providers = [
    {
      id: "provider",
      contextWindow: 64_000,
      models: [
        {
          id: "gpt-5.6-luna",
          contextWindow: 128_000,
          maxTokens: 8_192,
          thinkingLevels: [],
        },
      ],
    },
  ];

  assert.equal(
    resolveContextWindow("provider", "catalog-model", providerModels, providers),
    256_000,
  );
  assert.equal(
    resolveContextWindow("provider", "gpt-5.6-luna", providerModels, providers),
    1_050_000,
  );
  assert.equal(
    resolveContextWindow("provider", "unknown-model", providerModels, providers),
    64_000,
  );
});

test("context window uses the selected binding before the model list loads", () => {
  const providers = [
    {
      id: "provider",
      contextWindow: 128_000,
      models: [
        {
          id: "gpt-5.6-luna",
          contextWindow: 1_050_000,
          maxTokens: 128_000,
          thinkingLevels: [],
        },
      ],
    },
  ];

  assert.equal(
    resolveContextWindow("provider", "gpt-5.6-luna", {}, providers),
    1_050_000,
  );
});

test("context usage falls back to input and output when total is absent", () => {
  assert.equal(
    usageTokenTotal({ inputTokens: 12, outputTokens: 8, totalTokens: 0 }),
    20,
  );
});

test("generation throughput uses provider output and stream duration", () => {
  assert.equal(calculateTokenRate(1_200, 4_000), 300);
  assert.equal(calculateTokenRate(0, 4_000), undefined);
  assert.equal(calculateTokenRate(1_200, undefined), undefined);
});

test("stopped responses get immediate estimated output and duration metadata", () => {
  const message = {
    id: "assistant-1",
    role: "assistant",
    content: "Partial answer",
    thinking: "Reasoning",
    createdAt: "2026-08-11T00:00:00.000Z",
    status: "streaming",
  };
  assert.equal(estimateResponseOutputTokens(message), 6);
  assert.deepEqual(
    settleStoppedAssistantMetrics(message, Date.parse("2026-08-11T00:00:02.500Z")),
    {
      ...message,
      responseDurationMs: 2_500,
      responseOutputTokens: 6,
    },
  );
});

test("cache rate measures cached prompt tokens against the full prompt", () => {
  assert.equal(calculateCacheRate(100, 300), 75);
  assert.equal(calculateCacheRate(100, 0), 0);
  assert.equal(calculateCacheRate(0, 100), 100);
  assert.equal(calculateCacheRate(100, undefined), undefined);
  assert.equal(calculateCacheRate(0, 0), undefined);
});

test("tool usage exposes argument and result estimates", () => {
  const message = {
    id: "tool-1",
    role: "tool",
    content: "result text",
    createdAt: new Date().toISOString(),
    toolName: "read",
    toolArgs: { path: "src/index.ts" },
    toolResult: { content: [{ type: "text", text: "result text" }] },
  };
  const usage = estimateToolTokenUsage(message);

  assert.ok(usage.argumentTokens > 0);
  assert.ok(usage.resultTokens > 0);
  assert.equal(usage.totalTokens, usage.argumentTokens + usage.resultTokens);
  assert.equal(usage.estimated, true);
  assert.deepEqual(toolTokenUsage({ ...message, toolUsage: usage }), usage);
});

test("tool usage aggregates repeated calls in first-seen order", () => {
  const messages = [
    {
      id: "tool-1",
      role: "tool",
      content: "first result",
      createdAt: new Date().toISOString(),
      toolName: "read",
      toolUsage: {
        argumentTokens: 10,
        resultTokens: 20,
        totalTokens: 30,
        estimated: true,
      },
      toolDurationMs: 100,
    },
    {
      id: "tool-2",
      role: "tool",
      content: "second result",
      createdAt: new Date().toISOString(),
      toolName: "bash",
      toolUsage: {
        argumentTokens: 4,
        resultTokens: 6,
        totalTokens: 10,
        estimated: true,
      },
      toolDurationMs: 250,
    },
    {
      id: "tool-3",
      role: "tool",
      content: "third result",
      createdAt: new Date().toISOString(),
      toolName: "read",
      toolUsage: {
        argumentTokens: 7,
        resultTokens: 13,
        totalTokens: 20,
        estimated: true,
      },
      toolDurationMs: 300,
    },
  ];

  assert.deepEqual(aggregateToolTokenUsage(messages), [
    {
      toolName: "read",
      callCount: 2,
      argumentTokens: 17,
      resultTokens: 33,
      totalTokens: 50,
      durationMs: 400,
      estimated: true,
    },
    {
      toolName: "bash",
      callCount: 1,
      argumentTokens: 4,
      resultTokens: 6,
      totalTokens: 10,
      durationMs: 250,
      estimated: true,
    },
  ]);
});
