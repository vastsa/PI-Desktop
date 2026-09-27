/**
 * The subagent editor pins a model from the configured, runnable, explicitly
 * delegated list. These tests pin that mapping so a later edit cannot silently
 * expose an opted-out model, put the custom field back, or drop an existing
 * pin.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  groupSubagentModelChoices,
  isSubagentModelProvider,
  subagentModelChoices,
  subagentModelOrphanPin,
  subagentModelPin,
  subagentModelSelectValue,
} = await import("../src/components/settings/subagent-models.ts");

const binding = (id, availableForSubagents = true) => ({
  id,
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
  availableForSubagents,
});

const provider = (over = {}) => ({
  id: "p1",
  name: "Anthropic",
  vendorKey: "anthropic",
  enabled: true,
  hasSecret: true,
  hasOauth: false,
  authKind: "api_key_and_base_url",
  models: [binding("claude-haiku-4-5"), binding("claude-sonnet-4-6")],
  ...over,
});

test("a pin uses the vendor key a person would type, not the UUID", () => {
  assert.equal(
    subagentModelPin({ vendorKey: "anthropic", name: "Anthropic" }, "claude-haiku-4-5"),
    "anthropic/claude-haiku-4-5",
  );
});

test("a custom endpoint uses its display name instead of the generic vendor key", () => {
  assert.equal(
    subagentModelPin({ vendorKey: "custom", name: "My Gateway" }, "local-model"),
    "My Gateway/local-model",
  );
});

test("the sheet lists configured models from enabled, credentialed providers", () => {
  const choices = subagentModelChoices([
    provider(),
    provider({
      id: "p2",
      name: "My Gateway",
      vendorKey: "",
      models: [binding("local-model")],
    }),
    provider({
      id: "off",
      name: "Disabled",
      vendorKey: "openai",
      enabled: false,
      models: [binding("gpt-5")],
    }),
    provider({
      id: "empty",
      name: "No key",
      vendorKey: "openai",
      hasSecret: false,
      authKind: "api_key_and_base_url",
      models: [binding("gpt-5")],
    }),
  ]);

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6", "My Gateway/local-model"],
  );
});

test("the sheet only lists bindings explicitly enabled for subagents", () => {
  const choices = subagentModelChoices([
    provider({
      models: [
        binding("claude-haiku-4-5", true),
        binding("claude-sonnet-4-6", false),
        {
          ...binding("claude-opus-4-6"),
          availableForSubagents: undefined,
        },
      ],
    }),
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.modelId),
    ["claude-haiku-4-5"],
  );
});

test("a vendor-account row with only OAuth still offers its configured models", () => {
  const choices = subagentModelChoices([
    provider({
      id: "oauth",
      name: "Claude Pro",
      vendorKey: "anthropic",
      hasSecret: false,
      hasOauth: true,
      authKind: "oauth",
      models: [binding("claude-opus-4-6")],
    }),
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["anthropic/claude-opus-4-6"],
  );
});

test("a no-auth local provider still offers its configured models", () => {
  const choices = subagentModelChoices([
    provider({
      id: "local",
      name: "Ollama",
      vendorKey: "",
      hasSecret: false,
      authKind: "none",
      models: [binding("llama3")],
    }),
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["Ollama/llama3"],
  );
  assert.equal(
    isSubagentModelProvider(
      provider({ authKind: "none", hasSecret: false, vendorKey: "" }),
    ),
    true,
  );
});

test("duplicate vendor keys use unique provider names so both providers remain selectable", () => {
  const choices = subagentModelChoices([
    provider({ name: "Anthropic work" }),
    provider({
      id: "p2",
      name: "Anthropic personal",
      vendorKey: "anthropic",
      models: [binding("claude-haiku-4-5")],
    }),
  ]);
  assert.deepEqual(choices.map((choice) => choice.value), [
    "Anthropic work/claude-haiku-4-5",
    "Anthropic work/claude-sonnet-4-6",
    "Anthropic personal/claude-haiku-4-5",
  ]);
});

test("same-name providers fall back to the stored provider id", () => {
  const choices = subagentModelChoices([
    provider({ name: "Gateway", vendorKey: "custom" }),
    provider({ id: "p2", name: "Gateway", vendorKey: "custom" }),
  ]);
  assert.deepEqual(choices.map((choice) => choice.value), [
    "p1/claude-haiku-4-5",
    "p1/claude-sonnet-4-6",
    "p2/claude-haiku-4-5",
    "p2/claude-sonnet-4-6",
  ]);
});

test("choices group by the owning provider", () => {
  const groups = groupSubagentModelChoices(
    subagentModelChoices([
      provider(),
      provider({
        id: "p2",
        name: "My Gateway",
        vendorKey: "",
        models: [binding("local-model")],
      }),
    ]),
  );
  assert.deepEqual(
    groups.map((group) => ({
      providerName: group.providerName,
      models: group.choices.map((choice) => choice.modelId),
    })),
    [
      { providerName: "Anthropic", models: ["claude-haiku-4-5", "claude-sonnet-4-6"] },
      { providerName: "My Gateway", models: ["local-model"] },
    ],
  );
});

test("a pin written with the display name still selects the vendor-key option", () => {
  const choices = subagentModelChoices([provider()]);
  assert.equal(
    subagentModelSelectValue("Anthropic/claude-haiku-4-5", choices),
    "anthropic/claude-haiku-4-5",
  );
  assert.equal(subagentModelOrphanPin("Anthropic/claude-haiku-4-5", choices), null);
  assert.equal(subagentModelSelectValue("", choices), "");
});

test("a pin that is no longer configured stays selectable", () => {
  const choices = subagentModelChoices([provider()]);
  assert.equal(
    subagentModelSelectValue("openai/gpt-5", choices),
    "openai/gpt-5",
  );
  assert.equal(subagentModelOrphanPin("openai/gpt-5", choices), "openai/gpt-5");
});

test("the editor model field offers configured, custom, and empty-list paths", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
    "utf8",
  );
  const modelField = source.slice(
    source.indexOf('label={t("extensions.subagents.model")}'),
    source.indexOf('label={t("extensions.subagents.thinking")}'),
  );
  assert.match(modelField, /<Select/);
  assert.match(modelField, /<optgroup/);
  assert.match(modelField, /extensions\.subagents\.modelInherit/);
  assert.match(modelField, /extensions\.subagents\.modelPickCustom/);
  assert.match(modelField, /extensions\.subagents\.modelPickEmpty/);
  assert.match(source, /subagentModelChoices\(providers\)/);
  assert.match(source, /CUSTOM_SUBAGENT_MODEL_VALUE/);
  assert.match(source, /extensions\.subagents\.modelPickCustomHint/);
  assert.match(source, /resetSubagentTemplate\(draft\)/);
});

test("the editor exposes the no-pass thinking option", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
    "utf8",
  );
  const thinkingField = source.slice(
    source.indexOf('label={t("extensions.subagents.thinking")}'),
  );
  assert.match(thinkingField, /value="omit"/);
  assert.match(thinkingField, /extensions\.subagents\.thinkingOmit/);
  assert.match(thinkingField, /SUBAGENT_THINKING_LEVELS/);
});
