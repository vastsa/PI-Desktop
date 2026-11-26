import assert from "node:assert/strict";
import test from "node:test";
import { composerModelSections } from "../src/features/chat/composer/model-sections.ts";
import { starAiGroupRatioLabel } from "../src/lib/star-ai-group-ratio.ts";

const group = (id, name, ids, ratio, chatModels = ids) => ({
  provider: { id, name, starAiGroup: { id: name, ratio, chatModels } },
  providerDisplayName: name,
  providerSearchText: name,
  models: ids.map((modelId) => ({ modelId, providerId: id })),
});

test("site service cards count square-visible billing groups and preserve their complete routes", () => {
  const unverified = group("starai-managed-old", "GPT old", ["gpt-old"]);
  delete unverified.provider.starAiGroup.chatModels;
  const groups = [
    group("starai-managed-low", "gpt low", ["gpt-5", "claude-sonnet"], 0),
    group("starai-managed-high", "gpt high", ["gpt-5"], 2),
    group("starai-managed-media", "GPT 视频", ["media-model"], 1, []),
    group("starai-managed-mixed", "综合渠道", ["gpt-5"], 1),
    group("starai-managed-auto", "auto", ["published-any"], "auto"),
    group("starai-managed-empty", "Gemini", [], 1),
    unverified,
    group("manual", "Local provider", ["custom"]),
  ];
  const sections = composerModelSections(groups);
  assert.deepEqual(sections.map(({ id }) => id), ["service:gpt", "service:other", "auto", "provider:manual"]);
  assert.equal(sections[0].count, 2);
  assert.deepEqual(sections[0].groups.map(({ provider, models }) => [provider.id, models.map(model => model.modelId)]),
    [["starai-managed-high", ["gpt-5"]], ["starai-managed-low", ["gpt-5", "claude-sonnet"]]]);
});

test("ratios distinguish a free route, a missing multiplier and automatic billing", () => {
  assert.equal(starAiGroupRatioLabel(0.375, "自动"), "0.375×");
  assert.equal(starAiGroupRatioLabel(0, "自动"), "0×");
  assert.equal(starAiGroupRatioLabel("auto", "自动"), "自动");
  assert.equal(starAiGroupRatioLabel(undefined, "自动"), undefined);
});
