import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOptimisticSessionConfiguration,
  providerThinkingLevels,
  resolveComposerThinkingProvider,
} from "../src/lib/session-thinking.ts";

const reasoningProvider = {
  id: "bigmodel",
  supportsReasoning: true,
  supportedThinkingLevels: ["low", "high", "max"],
};

const catalogThinkingProvider = {
  ...reasoningProvider,
};

test("unpinned degraded session caps stay on the catalog thinking menu", () => {
  const thinkingProvider = resolveComposerThinkingProvider({
    provider: reasoningProvider,
    modelId: "glm-5.3-flash",
    activeSession: {
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    },
    catalogThinkingProvider,
  });
  assert.equal(thinkingProvider?.supportsReasoning, true);
  assert.deepEqual(providerThinkingLevels(thinkingProvider), ["low", "high", "max"]);
});

test("optimistic pin of an unpinned session drops stale capability fields", () => {
  const pinned = applyOptimisticSessionConfiguration(
    {
      supportsReasoning: false,
      supportsVision: false,
      supportedThinkingLevels: ["off"],
    },
    {
      providerId: "bigmodel",
      modelId: "glm-5.3-flash",
      thinkingLevel: "high",
    },
  );
  assert.equal(pinned.providerId, "bigmodel");
  assert.equal(pinned.modelId, "glm-5.3-flash");
  assert.equal(pinned.thinkingLevel, "high");
  assert.equal(pinned.supportsReasoning, undefined);
  assert.equal(pinned.supportsVision, undefined);
  assert.equal(pinned.supportedThinkingLevels, undefined);

  const thinkingProvider = resolveComposerThinkingProvider({
    provider: reasoningProvider,
    modelId: "glm-5.3-flash",
    activeSession: pinned,
    catalogThinkingProvider,
  });
  assert.equal(thinkingProvider?.supportsReasoning, true);
  assert.deepEqual(providerThinkingLevels(thinkingProvider), ["low", "high", "max"]);
});

test("empty session thinking levels fall back to the catalog instead of Off-only", () => {
  const thinkingProvider = resolveComposerThinkingProvider({
    provider: reasoningProvider,
    modelId: "glm-5.3-flash",
    activeSession: {
      providerId: "bigmodel",
      modelId: "glm-5.3-flash",
      supportsReasoning: true,
      supportedThinkingLevels: [],
    },
    catalogThinkingProvider,
  });
  assert.deepEqual(providerThinkingLevels(thinkingProvider), ["low", "high", "max"]);
});

test("usable session capabilities still win over the catalog", () => {
  const thinkingProvider = resolveComposerThinkingProvider({
    provider: reasoningProvider,
    modelId: "glm-5.3-flash",
    activeSession: {
      providerId: "bigmodel",
      modelId: "glm-5.3-flash",
      supportsReasoning: true,
      supportedThinkingLevels: ["high", "max"],
    },
    catalogThinkingProvider,
  });
  assert.deepEqual(providerThinkingLevels(thinkingProvider), ["high", "max"]);
});

test("changing only the thinking level keeps pinned session capabilities", () => {
  const next = applyOptimisticSessionConfiguration(
    {
      providerId: "bigmodel",
      modelId: "glm-5.3-flash",
      supportsReasoning: true,
      supportedThinkingLevels: ["low", "high", "max"],
    },
    { thinkingLevel: "low", providerId: "bigmodel", modelId: "glm-5.3-flash" },
  );
  assert.equal(next.supportsReasoning, true);
  assert.deepEqual(next.supportedThinkingLevels, ["low", "high", "max"]);
});
