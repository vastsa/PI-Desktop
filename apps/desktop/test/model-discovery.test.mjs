import assert from "node:assert/strict";
import test from "node:test";
import {
  modelListRequest,
  normalizeModelList,
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
