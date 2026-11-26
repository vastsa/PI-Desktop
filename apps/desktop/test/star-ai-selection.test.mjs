import assert from "node:assert/strict";
import test from "node:test";
import { emptyStarAiDraft, starAiDraft } from "../src/components/settings/star-ai-selection.ts";

const groups = [
  { id: "gpt满血渠道", models: ["gpt-4o"], chatModels: ["gpt-4o"] },
  { id: "gpt ultra fast", models: ["gpt-4o", "gpt-image-1"], chatModels: ["gpt-4o"] },
  { id: "视频生成组", models: ["sora-2"], chatModels: [] },
];
const catalog = { groups, selection: { group: groups[0].id, model: "gpt-4o" } };

test("only a valid saved route restores the default on entry", () => {
  assert.deepEqual(starAiDraft(catalog), { service: "gpt", ...catalog.selection });
  assert.deepEqual(starAiDraft({ ...catalog, selection: null }), emptyStarAiDraft);
  assert.deepEqual(starAiDraft({ ...catalog, groups: [] }), emptyStarAiDraft);
});

test("refresh preserves a browsed chat service and drops view-only media service", () => {
  const browsingMedia = { service: "media", group: "", model: "" };
  assert.deepEqual(starAiDraft(catalog, browsingMedia), emptyStarAiDraft);
  const browsingGpt = { service: "gpt", group: "", model: "" };
  assert.deepEqual(starAiDraft(catalog, browsingGpt), browsingGpt);
  const groupOnly = { service: "gpt", group: groups[1].id, model: "" };
  assert.deepEqual(starAiDraft(catalog, groupOnly), groupOnly);
  assert.deepEqual(starAiDraft(catalog, { ...groupOnly, model: "gpt-image-1" }), groupOnly);
  assert.deepEqual(starAiDraft(catalog, { ...groupOnly, model: "delisted" }), groupOnly);
  assert.deepEqual(starAiDraft({ ...catalog, groups: [groups[0]] }, groupOnly), { service: "gpt", group: "", model: "" });
});

test("automatic routing is separate from named services", () => {
  const automatic = { id: "auto", models: ["gpt-4o"], chatModels: ["gpt-4o"] };
  const selection = { group: "auto", model: "gpt-4o" };
  assert.deepEqual(starAiDraft({ groups: [automatic], selection }), { service: null, ...selection });
});
