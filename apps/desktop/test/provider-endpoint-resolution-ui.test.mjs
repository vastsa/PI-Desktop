/**
 * Retained upstream endpoint resolution and the fixed platform setup boundary.
 *
 * Generic resolution helpers preserve their existing contracts, but platform
 * setup never adopts another endpoint or infers a different transport from a
 * discovery answer. Explicit API format and configured wire IDs stay intact.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  endpointSuggestion,
  getBaseUrlIssue,
  normalizeBaseUrlInput,
  resolveEndpointDraft,
} = await import("../src/components/settings/provider-endpoint-guidance.ts");

const setupSource = await readFile(
  new URL("../src/components/settings/ProviderSetupDialog.tsx", import.meta.url),
  "utf8",
);

test("a bare host is accepted and completed inside the origin the user named", () => {
  assert.equal(getBaseUrlIssue("api.example.com"), null);
  assert.equal(normalizeBaseUrlInput("api.example.com", "chat_completions"), "https://api.example.com");
  assert.equal(normalizeBaseUrlInput("api.example.com/", "chat_completions"), "https://api.example.com");
  // Anything that could hide a credential or a query is still refused.
  for (const value of ["https://user:secret@api.example.com", "https://api.example.com?key=x", "not a url"]) {
    assert.equal(getBaseUrlIssue(value), "invalid", value);
  }
});

test("a pasted operation resolves the format and the base address together", () => {
  const draft = resolveEndpointDraft("https://relay.example/v1/responses", "chat_completions", false);
  assert.equal(draft.apiStyle, "responses");
  assert.equal(draft.effectiveBaseUrl, "https://relay.example/v1");
  assert.equal(draft.autoDetected, true);
  assert.equal(draft.evidence, "url_suffix");
});

test("a published service address names its own format", () => {
  const draft = resolveEndpointDraft("https://api.anthropic.com", "chat_completions", false);
  assert.equal(draft.apiStyle, "anthropic_messages");
  assert.equal(draft.autoDetected, true);
});

test("a format the user chose is never changed by the endpoint", () => {
  const explicit = resolveEndpointDraft("https://api.anthropic.com", "chat_completions", true);
  assert.equal(explicit.apiStyle, "chat_completions");
  assert.equal(explicit.autoDetected, false);

  // Nothing is inferred from an unknown address, so a saved legacy format stays.
  const unknown = resolveEndpointDraft("https://relay.example", "pi_messages", false);
  assert.equal(unknown.apiStyle, "pi_messages");
  assert.equal(unknown.autoDetected, false);
});

test("every existing special wire style survives resolution", () => {
  for (const [baseUrl, apiStyle] of [
    ["https://opencode.ai/zen/go/v1", "opencode_go"],
    ["https://api.openai.com/v1", "responses"],
    ["https://api.anthropic.com", "pi_messages"],
    ["https://api.anthropic.com", "openai_codex_responses"],
  ]) {
    assert.equal(
      resolveEndpointDraft(baseUrl, apiStyle, true).apiStyle,
      apiStyle,
      `${baseUrl} ${apiStyle}`,
    );
  }
});

test("a resolved address is stable, so adopting it cannot loop", () => {
  // Discovery resolves https://api.foo.com to .../v1, the form shows and
  // saves that, and probing it again must not extend it further.
  const resolved = "https://api.foo.com/v1";
  assert.equal(normalizeBaseUrlInput(resolved, "chat_completions"), resolved);
  assert.equal(resolveEndpointDraft(resolved, "chat_completions", false).effectiveBaseUrl, resolved);
  // A mismatched operation is preserved until the user resolves it.
  assert.equal(
    normalizeBaseUrlInput("https://api.foo.com/v1/responses", "chat_completions"),
    "https://api.foo.com/v1/responses",
  );
  assert.deepEqual(endpointSuggestion("https://api.foo.com/v1/responses", "chat_completions"), {
    baseUrl: "https://api.foo.com/v1",
    apiStyle: "responses",
  });
});

test("platform discovery cannot replace the displayed or saved endpoint", () => {
  assert.match(setupSource, /baseUrl: AI_PLATFORM_BASE_URL/);
  assert.doesNotMatch(setupSource, /resolveEndpointDraft\(|discovery\.effectiveBaseUrl|setBaseUrl/);
  assert.doesNotMatch(setupSource, /ProviderEndpointGuidance|settings\.apiStyleAutoDetected/);
  // The retained generic resolver still handles old endpoint data; its result
  // is deliberately not wired into this edition's setup form.
  const draft = resolveEndpointDraft("https://relay.example/v1/responses", "chat_completions", false);
  assert.equal(draft.effectiveBaseUrl, "https://relay.example/v1");
});

test("a saved or copied supported format is preserved without endpoint inference", () => {
  assert.match(setupSource, /initialDraft\?\.apiStyle \?\? provider\?\.apiStyle/);
  assert.match(setupSource, /isPlatformApiStyle\(style\) \? style : "chat_completions"/);
  assert.doesNotMatch(setupSource, /resolvedApiStyle|namedPreset\?\.apiStyle/);
  const saved = resolveEndpointDraft("https://api.openai.com/v1", "chat_completions", true);
  assert.equal(saved.apiStyle, "chat_completions");
  assert.equal(saved.autoDetected, false);
  assert.equal(resolveEndpointDraft("https://api.openai.com/v1", "chat_completions", false).apiStyle, "responses");
});

test("a hand-picked platform format drives discovery and persistence directly", () => {
  assert.match(setupSource, /onApiStyleChange=\{setApiStyle\}/);
  assert.match(setupSource, /apiStyle=\{apiStyle\}/);
  assert.doesNotMatch(setupSource, /setApiStyleTouched|setChoosing|pickService|endpointDraft/);
  // Persisted wire IDs and endpoint format remain distinct fields.
  assert.match(setupSource, /models: persisted,\s+apiStyle,/);
});

test("the saved model ids stay the ids the endpoint served", () => {
  // Platform media defaults are added; unrelated endpoint wire IDs stay intact.
  // Metadata may be borrowed through an alias, but a binding is addressed
  // with the wire id, so the form must not rewrite one.
  assert.match(setupSource, /const persisted = platformMediaModelBindings\(selection\.bindingsToPersist\);/);
  assert.match(setupSource, /models: persisted,/);
  assert.doesNotMatch(setupSource, /\.id\s*=\s*(?!==)/);
});
