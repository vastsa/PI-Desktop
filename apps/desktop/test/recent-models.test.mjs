import assert from "node:assert/strict";
import test from "node:test";
import { loadRecentModels, rememberModelInList, saveRecentModels } from "../src/lib/recent-models.ts";
import { availableRecentModels, inheritedSessionModelBinding, pinnedSessionModelBinding } from "../src/lib/session-model.ts";

const ref = (providerId, modelId) => ({ providerId, modelId });
const providers = [
  { id: "a", enabled: true, authKind: "none", models: [{ id: "one" }, { id: "two" }, { id: "image" }, { id: "gpt-image-1" }] },
  { id: "b", enabled: true, authKind: "api_key", hasSecret: true, models: [{ id: "one" }] },
];
const settings = { defaultProviderId: "a", defaultModelId: "one", imageGenerationModels: [ref("a", "gpt-image-1")] };

test("recent selection restores after reload and deduplicates exact provider/model pairs", () => {
  const old = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  try {
    let list = [];
    for (const model of [ref("a", "one"), ref("b", "one"), ref("a", "two"), ref("a", "ONE")]) {
      list = rememberModelInList(list, model);
    }
    saveRecentModels(list);
    const restored = loadRecentModels();
    assert.deepEqual(restored, [ref("a", "ONE"), ref("a", "two"), ref("b", "one")]);
    assert.deepEqual(inheritedSessionModelBinding({ providers, settings, recentModels: restored }), ref("a", "ONE"));
  } finally { globalThis.localStorage = old; }
});

test("new chat inherits recent available model and existing chats retain their own binding", () => {
  const recentModels = [ref("b", "one"), ref("a", "two")];
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings, recentModels }), ref("b", "one"));
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings, recentModels, draft: ref("a", "two") }), ref("a", "two"));
  assert.deepEqual(pinnedSessionModelBinding({ providers, settings, recentModels, session: ref("a", "one") }), ref("a", "one"));
});

test("deleted, disabled, unauthenticated and pure image endpoints are skipped before inheritance", () => {
  const recentModels = [ref("missing", "one"), ref("a", "removed"), ref("a", "gpt-image-1"), ref("b", "one"), ref("a", "two")];
  for (const unavailable of [{ enabled: false }, { hasSecret: false }]) {
    const current = [providers[0], { ...providers[1], ...unavailable }];
    assert.deepEqual(availableRecentModels(recentModels, current, settings), [ref("a", "two")]);
    assert.deepEqual(inheritedSessionModelBinding({ providers: current, settings, recentModels }), ref("a", "two"));
  }
});

test("first run preserves a valid legacy selection, otherwise selects a runnable chat model", () => {
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings }), ref("a", "one"));
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings: { defaultProviderId: "missing", defaultModelId: "gone" } }), ref("a", "one"));
  assert.deepEqual(inheritedSessionModelBinding({ providers: [] }), {});
  // A dual-capability image-marked model with no discovered metadata stays
  // chat-eligible, so it is inherited like any other chat model (#2253).
  assert.deepEqual(inheritedSessionModelBinding({ providers, recentModels: [ref("a", "image")],
    settings: { ...settings, imageGenerationModels: [], imageGeneration: ref("a", "image") },
  }), ref("a", "image"));
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings, draft: { providerId: "b" } }), ref("b", "one"));
});

test("a dual-capability default model marked for images is inherited by a new chat", () => {
  const imageMarked = { ...settings, defaultModelId: "image", imageGenerationModels: [ref("a", "image")] };
  // The saved chat default and the recent selection are both inherited: only a
  // pure image endpoint (or discovered no-text-output row) is excluded (#2253).
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings: imageMarked }), ref("a", "image"));
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings: imageMarked, recentModels: [ref("a", "image")] }), ref("a", "image"));
  // Discovery metadata that publishes no text output excludes the model, so
  // inheritance falls to the provider's next runnable chat model.
  const imageOnlyMetadata = [
    { modelId: "image", displayName: "image", providerId: "a", modalities: { output: ["image"] } },
  ];
  assert.deepEqual(
    inheritedSessionModelBinding({ providers, settings: imageMarked, discovered: imageOnlyMetadata }),
    ref("a", "one"),
  );
  const dualMetadata = [
    { modelId: "image", displayName: "image", providerId: "a", modalities: { output: ["text", "image"] } },
  ];
  assert.deepEqual(
    inheritedSessionModelBinding({ providers, settings: imageMarked, discovered: dualMetadata }),
    ref("a", "image"),
  );
});

test("corrupt local preferences are ignored and history remains bounded", () => {
  const old = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => '{broken' };
    assert.deepEqual(loadRecentModels(), []);
    globalThis.localStorage = { getItem: () => JSON.stringify([null, {}, ref("a", "one"), ref("a", "one"), ref("", "two")]) };
    assert.deepEqual(loadRecentModels(), [ref("a", "one")]);
    let history = [];
    for (let i = 0; i < 30; i++) history = rememberModelInList(history, ref("a", String(i)));
    assert.equal(history.length, 20);
    assert.equal(history[0].modelId, "29");
  } finally { globalThis.localStorage = old; }
});
