/**
 * The models a new AI service starts with. A service is usable once its key is
 * saved only when the preselection is a chat model that can call tools; the
 * first pick becomes the service's default, so it must be a current model and
 * never a premium tier or a community route that happens to be newer.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PREMIUM_OUTPUT_COST_PER_MILLION, canRecommendFrom, recommendModels } = await import(
  "../src/components/settings/recommended-models.ts"
);

const model = (modelId, over = {}) => ({
  modelId,
  displayName: modelId,
  providerId: "p1",
  capabilities: ["text", "tools"],
  source: "discovered",
  catalogSource: "models.dev",
  toolCall: true,
  modalities: { input: ["text"], output: ["text"] },
  ...over,
});

const ids = (models) => recommendModels(models).map((binding) => binding.id);

test("only tool-capable chat models are candidates", () => {
  assert.deepEqual(
    ids([
      model("text-embedding-3-large", { family: "embed", releaseDate: "2026-09-01" }),
      model("gpt-4o-mini-tts", { family: "tts", releaseDate: "2026-09-01" }),
      model("whisper-1", { family: "whisper", releaseDate: "2026-09-01" }),
      model("gpt-realtime", { family: "realtime", releaseDate: "2026-09-01" }),
      model("gemini-flash-live-preview", { family: "live", releaseDate: "2026-09-01" }),
      model("gpt-image-2", { family: "image", releaseDate: "2026-09-01" }),
      model("omni-moderation-latest", { family: "moderation", releaseDate: "2026-09-01" }),
      model("o3-deep-research", { family: "research", releaseDate: "2026-09-01" }),
      model("computer-use-preview", { family: "cua", releaseDate: "2026-09-01" }),
      model("sora-2", {
        family: "video",
        releaseDate: "2026-09-01",
        modalities: { input: ["text"], output: ["video"] },
      }),
      model("sonar", { family: "sonar", releaseDate: "2026-09-01", toolCall: false }),
      model("gpt-4-legacy", { family: "legacy", releaseDate: "2026-09-01", status: "deprecated" }),
      model("gpt-chat", { family: "gpt", releaseDate: "2026-01-01" }),
    ]),
    ["gpt-chat"],
  );
});

test("a model without published modalities still qualifies", () => {
  assert.deepEqual(ids([model("gateway-model", { modalities: undefined })]), ["gateway-model"]);
});

test("the newest model of each family wins, up to three", () => {
  const picked = ids([
    model("gpt-5", { family: "gpt", releaseDate: "2025-08-07", cost: { output: 10 } }),
    model("gpt-6-sol", { family: "gpt-sol", releaseDate: "2026-09-22", cost: { output: 10 } }),
    model("gpt-5.6-sol", { family: "gpt-sol", releaseDate: "2026-07-09", cost: { output: 20 } }),
    model("gpt-6-luna", { family: "gpt-luna", releaseDate: "2026-09-22", cost: { output: 0.5 } }),
    model("gpt-6-astra", { family: "gpt-astra", releaseDate: "2026-09-04", cost: { output: 50 } }),
  ]);
  // Same-day siblings put the pricier flagship first; older snapshots of a
  // picked family never take a slot.
  assert.deepEqual(picked, ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]);
});

test("a model without a family is its own family", () => {
  assert.deepEqual(
    ids([
      model("alpha-1", { releaseDate: "2026-01-03" }),
      model("alpha-2", { releaseDate: "2026-01-02" }),
    ]),
    ["alpha-1", "alpha-2"],
  );
});

test("premium tiers and pre-release models only fill leftover slots", () => {
  const premium = PREMIUM_OUTPUT_COST_PER_MILLION + 80;
  assert.deepEqual(
    ids([
      model("gpt-6-pro", { family: "gpt-pro", releaseDate: "2026-09-23", cost: { output: premium } }),
      model("glm-next", { family: "glm-next", releaseDate: "2026-09-23", status: "beta" }),
      model("gpt-6-sol", { family: "gpt-sol", releaseDate: "2026-09-22", cost: { output: 10 } }),
    ]),
    ["gpt-6-sol", "glm-next", "gpt-6-pro"],
  );
  // models.dev uses `experimental` for extra request modes, not for maturity.
  assert.deepEqual(
    ids([
      model("claude-opus-5-5", {
        family: "claude-opus",
        releaseDate: "2026-09-22",
        experimental: { modes: { fast: {} } },
      }),
      model("claude-sonnet-5", { family: "claude-sonnet", releaseDate: "2026-06-29" }),
    ]),
    ["claude-opus-5-5", "claude-sonnet-5"],
  );
});

test("an aggregator prefers known vendors over community routes", () => {
  assert.deepEqual(
    ids([
      model("thedrummer/cydonia-24b", { family: "cydonia", releaseDate: "2026-09-23" }),
      model("nousresearch/hermes-5", { family: "hermes", releaseDate: "2026-09-23" }),
      model("anthropic/claude-opus-5.5", {
        family: "claude-opus",
        releaseDate: "2026-09-22",
        cost: { output: 20 },
      }),
      model("openai/gpt-6-sol", { family: "gpt-sol", releaseDate: "2026-09-22", cost: { output: 10 } }),
      model("Qwen/Qwen3.8-27B", { family: "qwen", releaseDate: "2026-08-14" }),
    ]),
    ["anthropic/claude-opus-5.5", "openai/gpt-6-sol", "Qwen/Qwen3.8-27B"],
  );
  // Unprefixed ids on a direct vendor are not routes and keep their place.
  assert.deepEqual(
    ids([
      model("MiniMax/MiniMax-M2.7", { family: "minimax", releaseDate: "2026-03-18" }),
      model("qwen3.8-flash", { family: "qwen", releaseDate: "2026-08-26" }),
    ]),
    ["qwen3.8-flash", "MiniMax/MiniMax-M2.7"],
  );
});

test("models.dev-described models outrank ones it does not know", () => {
  assert.deepEqual(
    ids([
      model("private-tuned", { catalogSource: undefined, toolCall: undefined, family: undefined }),
      model("gpt-6-sol", { family: "gpt-sol", releaseDate: "2026-09-22" }),
    ]).slice(0, 1),
    ["gpt-6-sol"],
  );
});

test("an undescribed list picks only its first chat model", () => {
  const unknown = (modelId) =>
    model(modelId, { catalogSource: undefined, toolCall: undefined, modalities: undefined });
  assert.deepEqual(
    ids([unknown("nomic-embed-text"), unknown("llama3.3:70b"), unknown("qwen3:32b")]),
    ["llama3.3:70b"],
  );
});

test("nothing qualifies, nothing is picked", () => {
  assert.deepEqual(recommendModels([]), []);
  assert.deepEqual(ids([model("text-embedding-3-small")]), []);
  assert.deepEqual(recommendModels([model("gpt-6-sol")], 0), []);
});

test("only a list the service did not refuse is recommended from", () => {
  const ready = (source, error) => ({ status: "ready", source, ...(error ? { error } : {}) });
  assert.equal(canRecommendFrom(ready("remote"), false), true);
  assert.equal(canRecommendFrom(ready("catalog"), false), true);
  // A named vendor without a /models route still accepted the key.
  assert.equal(canRecommendFrom(ready("catalog", "HTTP 404 Not Found"), true), true);
  assert.equal(canRecommendFrom(ready("catalog", "HTTP 404 Not Found"), false), false);
  // A refused key or an unreachable host says nothing about the key.
  assert.equal(canRecommendFrom(ready("catalog", "HTTP 401 Unauthorized"), true), false);
  assert.equal(canRecommendFrom(ready("catalog", "fetch failed"), true), false);
  assert.equal(canRecommendFrom(ready("fallback"), true), false);
  assert.equal(canRecommendFrom(ready("cache"), true), false);
  assert.equal(canRecommendFrom({ status: "loading", source: "remote" }, true), false);
  assert.equal(canRecommendFrom({ status: "error", source: "remote" }, true), false);
});

test("picks are the same bindings a manual pick creates", () => {
  const [binding] = recommendModels([
    model("gpt-6-sol", {
      family: "gpt-sol",
      releaseDate: "2026-09-22",
      contextWindow: 400000,
      maxTokens: 128000,
      reasoning: true,
      supportedThinkingLevels: ["low", "medium", "high"],
    }),
  ]);
  assert.equal(binding.id, "gpt-6-sol");
  assert.equal(binding.contextWindow, 400000);
  assert.equal(binding.maxTokens, 128000);
  assert.equal(binding.contextWindowSource, "catalog");
  assert.equal(binding.defaultThinkingLevel, "medium");
  assert.equal(binding.supportsImages, null);
});
