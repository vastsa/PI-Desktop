/**
 * Behavioural tests for the provider naming shared by every provider list.
 *
 * Two vendor accounts of one vendor carry the same `provider.name`; only the
 * user's own `oauthAccountLabel` tells them apart (#785). The Composer already
 * resolved its heading that way, while Settings read `provider.name` directly
 * and rendered two identical rows, so these tests pin the one rule and pin the
 * Settings pickers to it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  providerDisplayName,
  providerSearchText,
} from "../src/lib/provider-display.ts";
import { defaultModelOptions } from "../src/components/settings/default-model.ts";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const binding = (id) => ({
  id,
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
});

/** An OAuth row: the vendor name is shared, the account label is not. */
const account = (id, oauthAccountLabel, modelId = "gpt-5.5") => ({
  id,
  name: "OpenAI",
  vendorKey: "openai",
  enabled: true,
  hasSecret: true,
  hasOauth: true,
  authKind: "oauth",
  oauthAccountLabel,
  models: [binding(modelId)],
});

test("a vendor account label names the provider", () => {
  assert.equal(
    providerDisplayName({ name: "Anthropic", oauthAccountLabel: "Work account" }),
    "Work account",
  );
});

test("a provider without an account label keeps its vendor name", () => {
  assert.equal(
    providerDisplayName({ name: "Anthropic", oauthAccountLabel: "  " }),
    "Anthropic",
  );
  assert.equal(providerDisplayName({ name: "Anthropic" }), "Anthropic");
});

test("both the account label and the vendor name stay searchable", () => {
  assert.equal(
    providerSearchText({ name: "Anthropic", oauthAccountLabel: "Work account" }),
    "Work account Anthropic",
  );
  // No label means no duplicated vendor name in the haystack.
  assert.equal(providerSearchText({ name: "Anthropic" }), "Anthropic");
});

/*
  This was the bug: the default picker expands both accounts into options, and
  naming them by `provider.name` rendered the same heading twice with no way to
  tell which account a default would be pinned to.
*/
test("two accounts of one vendor get distinct headings in the default picker", () => {
  const options = defaultModelOptions([
    account("p-work", "Work account"),
    account("p-personal", "Personal account"),
  ]);

  assert.deepEqual(
    options.map(({ provider }) => providerDisplayName(provider)),
    ["Work account", "Personal account"],
  );
});

test("the default picker's query reaches an account by its label", () => {
  const options = defaultModelOptions([
    account("p-work", "Work account"),
    account("p-personal", "Personal account"),
  ]);
  // The haystack the pickers build, matched the way they match it.
  const matches = (query) =>
    options.filter(({ provider, modelId }) =>
      `${providerSearchText(provider)} ${modelId}`.toLowerCase().includes(query),
    );

  assert.deepEqual(
    matches("personal").map(({ provider }) => provider.id),
    ["p-personal"],
  );
  // The vendor name still reaches every account of that vendor.
  assert.equal(matches("openai").length, 2);
  assert.equal(matches("gpt-5.5").length, 2);
});

test("the Settings model pickers name providers through the shared helper", async () => {
  for (const rel of [
    "../src/components/settings/ModelConfigPage.tsx",
    "../src/components/settings/EnhancementModelCard.tsx",
  ]) {
    const source = await read(rel);
    assert.match(source, /providerDisplayName\(provider\)/, rel);
    assert.match(source, /aria-label=\{`\$\{providerDisplayName\(provider\)\} · \$\{modelId\}`\}/, rel);
    assert.match(source, /`\$\{providerSearchText\(provider\)\} \$\{modelId\}`/, rel);
    // The raw vendor name must not come back for a picker row or its query.
    assert.doesNotMatch(source, /`\$\{provider\.name\} \$\{modelId\}`/, rel);
    assert.doesNotMatch(source, /aria-label=\{`\$\{provider\.name\} · \$\{modelId\}`\}/, rel);
  }
});

test("the Composer keeps resolving its heading through the same helper", async () => {
  const source = await read(
    "../src/features/chat/composer/hooks/useComposerModelMenu.ts",
  );
  assert.match(source, /providerDisplayName: providerDisplayName\(candidate\)/);
  assert.match(source, /providerSearchText: providerSearchText\(candidate\)/);
});
