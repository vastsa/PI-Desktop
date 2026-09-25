/**
 * Endpoint resolution as the setup form uses it.
 *
 * A user should be able to paste `api.example.com` and get a working row; the
 * address that really answered must be the one shown and saved; and a format
 * the user picked by hand must never be changed behind their back. These tests
 * pin those three promises, plus the regression it protects: a named service's
 * own wire format is not re-derived from its URL.
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

test("the form adopts the address that answered and says what it detected", () => {
  assert.match(setupSource, /resolveEndpointDraft\(/);
  assert.match(setupSource, /discovery\.effectiveBaseUrl/);
  // The answer belongs to the address it was produced for, so a URL typed since
  // that probe is never reverted to an earlier result.
  assert.match(setupSource, /const adoptedFrom = discovery\.resolvedFrom;/);
  assert.match(setupSource, /endpointsEqual\(current, adoptedFrom\) \? discoveredBaseUrl : current/);
  assert.match(setupSource, /\[named, discoveredBaseUrl, adoptedFrom\]/);
  assert.match(setupSource, /settings\.apiStyleAutoDetected/);
});

test("a format that already has an owner is never re-derived from the address", () => {
  // A stored row's format is the user's answer for that row; inference is for a
  // row that does not have one yet.
  assert.match(setupSource, /named \|\| editing \|\| Boolean\(initialDraft\) \|\| apiStyleTouched/);
  // Which is what keeps this a no-op on an existing custom row.
  const saved = resolveEndpointDraft("https://api.openai.com/v1", "chat_completions", true);
  assert.equal(saved.apiStyle, "chat_completions");
  assert.equal(saved.autoDetected, false);
  // Without that owner the same address is resolved, which is the new-row path.
  assert.equal(resolveEndpointDraft("https://api.openai.com/v1", "chat_completions", false).apiStyle, "responses");
});

test("a hand-picked format outranks the endpoint from then on", () => {
  assert.match(setupSource, /const \[apiStyleTouched, setApiStyleTouched\] = useState\(false\)/);
  assert.match(setupSource, /setApiStyleTouched\(true\);/);
  // Picking another service starts the choice over.
  assert.match(setupSource, /setApiStyleTouched\(false\);/);
});

test("the saved model ids stay the ids the endpoint served", () => {
  // Metadata may be borrowed through an alias, but a binding is addressed
  // with the wire id, so the form must not rewrite one.
  assert.match(setupSource, /const persisted = selection\.bindingsToPersist;/);
  assert.match(setupSource, /models: persisted,/);
  assert.doesNotMatch(setupSource, /\.id\s*=\s*(?!==)/);
});
