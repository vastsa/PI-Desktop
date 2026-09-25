import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { endpointSuggestion, normalizeBaseUrlInput } = await import(
  "../src/components/settings/provider-endpoint-guidance.ts"
);

test("pasted operation URLs suggest the matching format without guessing from a model or host", () => {
  for (const [suffix, apiStyle] of [["chat/completions", "chat_completions"], ["responses", "responses"], ["messages", "anthropic_messages"]]) {
    assert.deepEqual(endpointSuggestion(`https://relay.example/v1/${suffix}/`, "google_generative_ai"), {
      baseUrl: "https://relay.example/v1", apiStyle,
    });
    assert.equal(endpointSuggestion(`https://relay.example/v1/${suffix}`, apiStyle), undefined);
  }
  assert.equal(endpointSuggestion("https://relay.example/v1", "chat_completions"), undefined);
  assert.equal(endpointSuggestion("https://api.deepseek.com.evil.example", "chat_completions"), undefined);
});

test("unsafe or ambiguous addresses never produce a recommendation", () => {
  for (const url of ["", "not a url", "file:///messages", "https://user:secret@relay.example/messages", "https://relay.example/messages?key=secret", "https://relay.example/messages#fragment"]) {
    assert.equal(endpointSuggestion(url, "chat_completions"), undefined);
  }
});

test("normalization preserves mismatched operations until the user applies a recommendation", () => {
  assert.equal(normalizeBaseUrlInput("https://relay.example/v1/responses", "chat_completions"), "https://relay.example/v1/responses");
  assert.equal(normalizeBaseUrlInput("https://relay.example/v1/chat/completions/", "opencode_go"), "https://relay.example/v1");
  assert.equal(normalizeBaseUrlInput("https://relay.example/v1/responses", "opencode_go"), "https://relay.example/v1/responses");
});
