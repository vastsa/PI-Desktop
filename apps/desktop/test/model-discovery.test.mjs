import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DISCOVERED_MODELS,
  balancedSelection,
  modelListRequest,
  normalizeModelList,
  servedModelMetadata,
} from "../electron/main/model-discovery.ts";

test("openai-style lists normalize, dedupe, and sort", () => {
  const models = normalizeModelList("chat_completions", {
    object: "list",
    data: [
      { id: "gpt-4.1", object: "model" },
      { id: "deepseek-chat" },
      { id: "gpt-4.1" },
      { object: "model" },
    ],
  });
  assert.deepEqual(models, [
    { modelId: "deepseek-chat", displayName: "deepseek-chat" },
    { modelId: "gpt-4.1", displayName: "gpt-4.1" },
  ]);
  // Bare-array gateways parse the same way.
  assert.equal(normalizeModelList("responses", [{ id: "o4-mini" }]).length, 1);
});

test("a models[] response with slug rows is read as a list too", () => {
  /*
    Zhipu publishes three model-list shapes on one host: OpenAI Responses serves
    `{ models: [{ slug }] }`, Anthropic and the coding plan serve `{ data: [{ id }] }`.
    Reading only `data[].id` left the Responses row with an empty list, and the
    larger sweep then looked for the models somewhere else entirely.
  */
  assert.deepEqual(
    normalizeModelList("responses", {
      models: [
        { slug: "glm-5.3", display_name: "glm-5.3", context_window: 1_048_576, supported_in_api: true },
        { slug: "glm-5.3" },
      ],
    }),
    // The row states its own window, and that statement rides along.
    [{ modelId: "glm-5.3", displayName: "glm-5.3", contextWindow: 1_048_576 }],
  );
  // The two id keys are mutually exclusive; `id` wins if a gateway publishes both.
  assert.deepEqual(normalizeModelList("chat_completions", { models: [{ id: "m", slug: "s" }] }), [
    { modelId: "m", displayName: "m" },
  ]);
  // A Google list still takes its own branch and keeps the `models/` prefix off.
  assert.deepEqual(normalizeModelList("google_generative_ai", { models: [{ name: "models/gemini-3" }] }), [
    { modelId: "gemini-3", displayName: "gemini-3" },
  ]);
  // A data list still wins over a models wrapper when both are present.
  assert.deepEqual(normalizeModelList("responses", { data: [{ id: "a" }], models: [{ slug: "b" }] }), [
    { modelId: "a", displayName: "a" },
  ]);
});
test("anthropic lists keep display names", () => {
  const models = normalizeModelList("anthropic_messages", {
    data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
  });
  assert.deepEqual(models, [
    { modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  ]);
});

test("google lists strip the models/ prefix", () => {
  const models = normalizeModelList("google_generative_ai", {
    models: [
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { name: "models/gemini-2.5-flash" },
    ],
  });
  assert.deepEqual(models, [
    { modelId: "gemini-2.5-flash", displayName: "gemini-2.5-flash" },
    { modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
  ]);
});

test("requests use per-style endpoints and auth headers", () => {
  const openai = modelListRequest({
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
  });
  assert.equal(openai.url, "https://api.example.com/v1/models");
  assert.equal(openai.headers.Authorization, "Bearer sk-x");

  const anthropic = modelListRequest({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-a",
    apiStyle: "anthropic_messages",
  });
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(anthropic.headers["x-api-key"], "sk-a");
  assert.ok(anthropic.headers["anthropic-version"]);
  // A base already ending in /v1 is not doubled.
  assert.match(
    modelListRequest({ baseUrl: "https://gw.example/v1", apiStyle: "anthropic_messages" }).url,
    /^https:\/\/gw\.example\/v1\/models/,
  );

  const google = modelListRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "g-key",
    apiStyle: "google_generative_ai",
  });
  assert.match(google.url, /\/v1beta\/models\?/);
  assert.match(google.url, /key=g-key/);
  assert.deepEqual(google.headers, {});
});

test("OpenCode Go uses its fixed OpenAI-compatible model endpoint", () => {
  const request = modelListRequest({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "go-key",
    apiStyle: "opencode_go",
  });
  assert.equal(request.url, "https://opencode.ai/zen/go/v1/models");
  assert.equal(request.headers.Authorization, "Bearer go-key");
});

test("optional custom headers are attached to discovery requests", () => {
  const request = modelListRequest({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
    headers: { "User-Agent": "Custom/1.0", "X-Gateway": "1" },
  });
  assert.equal(request.headers.Authorization, "Bearer sk-x");
  assert.equal(request.headers["User-Agent"], "Custom/1.0");
  assert.equal(request.headers["X-Gateway"], "1");
  const smashed = modelListRequest({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
    headers: { Authorization: "Bearer other" },
  });
  assert.equal(smashed.headers.Authorization, "Bearer sk-x");
  const google = modelListRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiStyle: "google_generative_ai",
  });
  assert.equal(google.headers["User-Agent"], undefined);
});

test("a row's own metadata is read from the two published list shapes, positively only", () => {
  // Eden AI: a `capabilities` object of flags plus `context_length`.
  assert.deepEqual(
    servedModelMetadata({
      id: "anthropic/claude-sonnet-latest",
      context_length: 1_000_000,
      capabilities: {
        input_modalities: ["text", "image", "file"],
        supports_function_calling: true,
        supports_reasoning: true,
        supports_native_streaming: false,
      },
    }),
    { contextWindow: 1_000_000, toolCall: true, reasoning: true, inputModalities: ["text", "image", "file"] },
  );
  // OpenRouter: `architecture.input_modalities` plus `supported_parameters`.
  assert.deepEqual(
    servedModelMetadata({
      id: "openai/gpt-4o",
      context_length: 128_000,
      architecture: { input_modalities: ["text", "image"] },
      supported_parameters: ["tools", "tool_choice", "reasoning"],
    }),
    { contextWindow: 128_000, toolCall: true, reasoning: true, inputModalities: ["text", "image"] },
  );
  // Explicit `false` and a missing flag both add nothing; a plain row stays plain.
  assert.deepEqual(
    servedModelMetadata({ id: "x", capabilities: { supports_function_calling: false, supports_reasoning: null } }),
    {},
  );
  assert.deepEqual(servedModelMetadata({ id: "x" }), {});
  assert.deepEqual(servedModelMetadata(null), {});
});

test("malformed served metadata is dropped instead of corrupting the row", () => {
  for (const window of ["131072", -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1e12, {}, [131072]]) {
    assert.equal(servedModelMetadata({ id: "x", context_length: window }).contextWindow, undefined, String(window));
  }
  // A fractional count is rounded; `context_window` is the second spelling.
  assert.equal(servedModelMetadata({ id: "x", context_length: 4095.6 }).contextWindow, 4096);
  assert.equal(servedModelMetadata({ id: "x", context_window: 32_000 }).contextWindow, 32_000);
  // A non-object `capabilities`, a non-array parameter list, and junk modalities are ignored.
  assert.deepEqual(
    servedModelMetadata({
      id: "x",
      capabilities: "supports_function_calling",
      supported_parameters: "tools",
      architecture: { input_modalities: [1, null, "", "  "] },
    }),
    {},
  );
  // Flags are read as booleans, never as truthy strings.
  assert.deepEqual(
    servedModelMetadata({ id: "x", capabilities: { supports_function_calling: "true" } }),
    {},
  );
});

test("a gateway list keeps every routed id verbatim, including deep routes", () => {
  const models = normalizeModelList("chat_completions", {
    object: "list",
    data: [
      { id: "deepinfra/meta-llama/Llama-3.3-70B-Instruct", context_length: 131_072 },
      { id: "greenference/greenference/gemma-4-31b-it" },
      { id: "openai/gpt-latest", capabilities: { supports_function_calling: true } },
      { id: "openai/gpt-latest" },
      { id: "amazon/openai.gpt-6.1-sol" },
    ],
  });
  assert.deepEqual(models, [
    { modelId: "amazon/openai.gpt-6.1-sol", displayName: "amazon/openai.gpt-6.1-sol" },
    {
      modelId: "deepinfra/meta-llama/Llama-3.3-70B-Instruct",
      displayName: "deepinfra/meta-llama/Llama-3.3-70B-Instruct",
      contextWindow: 131_072,
    },
    { modelId: "greenference/greenference/gemma-4-31b-it", displayName: "greenference/greenference/gemma-4-31b-it" },
    { modelId: "openai/gpt-latest", displayName: "openai/gpt-latest", toolCall: true },
  ]);
});

/** A synthetic catalog: `count` rows per publisher, ids sorting by publisher name. */
function catalog(publishers) {
  return Object.entries(publishers).flatMap(([publisher, count]) =>
    Array.from({ length: count }, (_, index) => ({
      id: publisher ? `${publisher}/model-${String(index).padStart(4, "0")}` : `model-${String(index).padStart(4, "0")}`,
    })),
  );
}

test("a catalog larger than the bound keeps every publisher instead of an alphabetical head", () => {
  // Alphabetically early publishers alone exceed the bound, the way Eden AI's
  // amazon/, azure/, databricks/ and deepinfra/ rows precede openai/ and xai/.
  const body = catalog({
    amazon: 900,
    azure: 700,
    deepinfra: 600,
    mistral: 60,
    openai: 80,
    xai: 40,
    "": 5,
  });
  assert.ok(body.length > MAX_DISCOVERED_MODELS);
  const models = normalizeModelList("chat_completions", { data: body });
  assert.equal(models.length, MAX_DISCOVERED_MODELS);
  const byPublisher = new Map();
  for (const model of models) {
    const publisher = model.modelId.includes("/") ? model.modelId.split("/")[0] : "";
    byPublisher.set(publisher, (byPublisher.get(publisher) ?? 0) + 1);
  }
  // Small publishers survive whole; only the largest absorb the cut. Round
  // robin fills every publisher to depth 600 first (1,985 rows), so the last
  // 15 rows come from amazon and azure alone and deepinfra keeps all 600.
  assert.equal(byPublisher.get("openai"), 80);
  assert.equal(byPublisher.get("mistral"), 60);
  assert.equal(byPublisher.get("xai"), 40);
  assert.equal(byPublisher.get(""), 5);
  assert.equal(byPublisher.get("deepinfra"), 600);
  assert.equal(byPublisher.get("amazon"), 608);
  assert.equal(byPublisher.get("azure"), 607);
  // Output stays sorted, so a bounded list reads like an unbounded one.
  const ids = models.map((model) => model.modelId);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  // Deterministic: the same body always yields the same selection.
  assert.deepEqual(normalizeModelList("chat_completions", { data: body }), models);
});

test("balanced selection is a no-op under the bound and takes rows in sorted order within a publisher", () => {
  const sorted = catalog({ a: 3, b: 3 }).map((row) => ({ modelId: row.id })).sort((x, y) => x.modelId.localeCompare(y.modelId));
  assert.deepEqual(balancedSelection(sorted, 10), sorted);
  assert.deepEqual(
    balancedSelection(sorted, 4).map((model) => model.modelId),
    ["a/model-0000", "a/model-0001", "b/model-0000", "b/model-0001"],
  );
  // An odd bound gives the earlier publisher the extra row, deterministically.
  assert.deepEqual(
    balancedSelection(sorted, 3).map((model) => model.modelId),
    ["a/model-0000", "a/model-0001", "b/model-0000"],
  );
});

test("an ordinary large gateway list is returned whole", () => {
  const body = catalog({ openai: 400, anthropic: 300, vertex: 400 });
  assert.ok(body.length < MAX_DISCOVERED_MODELS);
  assert.equal(normalizeModelList("chat_completions", { data: body }).length, body.length);
});
