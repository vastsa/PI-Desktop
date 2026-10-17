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
  subagentModelDisplay,
  subagentModelOrphanPin,
  subagentModelPin,
  subagentModelPinParts,
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

test("saved model identity survives disable and re-enable without changing picker eligibility", () => {
  const configured = provider();
  const pin = "p1/claude-haiku-4-5";
  const available = subagentModelDisplay(pin, [configured]);
  assert.deepEqual(available, {
    providerId: "p1", providerName: "Anthropic", modelId: "claude-haiku-4-5", status: "available",
  });
  const disabled = { ...configured, enabled: false };
  assert.deepEqual(subagentModelDisplay(pin, [disabled]), { ...available, status: "disabled" });
  assert.deepEqual(subagentModelChoices([disabled]), []);
  assert.deepEqual(subagentModelDisplay(pin, [configured]), available);
  assert.deepEqual(subagentModelDisplay(pin, [{ ...configured, hasSecret: false }]), { ...available, status: "unavailable" });
});

test("display resolution accepts unique legacy aliases and rejects ambiguous account identity", () => {
  const first = provider({ name: "Shared Workspace", vendorKey: "custom" });
  const second = provider({ id: "p2", name: "Shared Workspace", vendorKey: "custom", enabled: false });
  assert.equal(subagentModelDisplay("Shared Workspace/claude-haiku-4-5", [first]).providerId, "p1");
  assert.equal(subagentModelDisplay("Shared Workspace/claude-haiku-4-5", [first, second]), null);
  assert.equal(subagentModelDisplay("p2/claude-haiku-4-5", [first, second]).providerId, "p2");
  assert.equal(subagentModelDisplay("custom/claude-haiku-4-5", [first]), null);
  const vendor = provider({ vendorKey: "shared_workspace", name: "Different", models: [] });
  assert.equal(subagentModelDisplay("Shared Workspace/claude-haiku-4-5", [first, vendor]), null);
  // An exact ID beats another provider's normalized name or vendor alias.
  assert.equal(subagentModelDisplay("p1/claude-haiku-4-5", [first, provider({ id: "p2", name: "p1" })]).providerId, "p1");
  assert.equal(subagentModelDisplay("Anthropic/CLAUDE-HAIKU-4-5", [provider()]).modelId, "claude-haiku-4-5");
  assert.equal(subagentModelDisplay("anthropic/claude-haiku-4-5", [provider(), provider({ id: "p2", enabled: false })]), null);
});

test("missing providers and bindings preserve unresolved pins instead of inventing identity", () => {
  assert.equal(subagentModelDisplay("deleted/claude-haiku-4-5", [provider()]), null);
  assert.equal(subagentModelDisplay("p1/deleted-model", [provider()]), null);
  assert.equal(subagentModelDisplay("not-a-pin", [provider()]), null);
  const legacy = provider({ models: [], defaultModelId: "legacy-model", enabled: false });
  assert.equal(subagentModelDisplay("p1/legacy-model", [legacy]).status, "disabled");
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

test("every option the picker offers is a pin the editor will save", () => {
  // A custom endpoint's display name contains spaces, and the picker offers it.
  // The editor's draft check must accept exactly what the picker produces, or
  // the user can pick an option and then never save the sheet.
  const choices = subagentModelChoices([
    provider(),
    provider({ id: "p2", name: "My Gateway", vendorKey: "custom" }),
    provider({ id: "p3", name: "My Ollama", vendorKey: "" }),
  ]);
  assert.ok(choices.length > 0);
  for (const choice of choices) {
    assert.notEqual(
      subagentModelPinParts(choice.value),
      null,
      `${choice.value} is offered but not saveable`,
    );
  }
});

test("a pin needs a provider half, a model half, and keeps its own slashes", () => {
  assert.deepEqual(subagentModelPinParts("anthropic/claude-haiku-4-5"), {
    providerPart: "anthropic",
    modelId: "claude-haiku-4-5",
  });
  assert.deepEqual(subagentModelPinParts("  My Gateway/local-model  "), {
    providerPart: "My Gateway",
    modelId: "local-model",
  });
  // An openrouter-style model id carries its own slashes; only the first one
  // separates the provider.
  assert.deepEqual(subagentModelPinParts("openrouter/deepseek/deepseek-chat"), {
    providerPart: "openrouter",
    modelId: "deepseek/deepseek-chat",
  });
  // A bare id has no provider to look up, so it is not a pin.
  assert.equal(subagentModelPinParts("claude-haiku-4-5"), null);
  assert.equal(subagentModelPinParts("/claude-haiku-4-5"), null);
  assert.equal(subagentModelPinParts("anthropic/"), null);
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

test("the sheet lists every configured binding regardless of the delegation flag", () => {
  // The editor no longer consults `availableForSubagents`: a model the user
  // configured in Settings is selectable, so the list cannot be empty while a
  // runnable provider exists.
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
    ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"],
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

test("a pin keeps the full configured model id even when its suffix is another model", () => {
  const choices = subagentModelChoices([provider({ models: [binding("generic/model"), binding("model")] })]);
  assert.equal(subagentModelSelectValue("anthropic/model", choices), "anthropic/model");
  assert.equal(subagentModelSelectValue("anthropic/GENERIC/MODEL", choices), "anthropic/generic/model");
  assert.equal(subagentModelOrphanPin("anthropic/other/model", choices), "anthropic/other/model");
  const prefixedOnly = choices.slice(0, 1);
  assert.equal(subagentModelOrphanPin("anthropic/model", prefixedOnly), "anthropic/model");
});

test("the editor model field is a configured-only searchable picker with an empty-state action", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
    "utf8",
  );
  const modelField = source.slice(
    source.indexOf('label={t("extensions.subagents.model")}'),
    source.indexOf('label={t("extensions.subagents.thinking")}'),
  );
  // A definition may pin any configured model, so the list is long enough that
  // a native <select> cannot serve it: the field is an anchored menu with a
  // filter field and its own scroll bound.
  assert.match(modelField, /<SubagentModelPicker/);
  assert.doesNotMatch(modelField, /<Select/);
  assert.doesNotMatch(modelField, /<optgroup/);
  assert.match(modelField, /extensions\.subagents\.modelPickEmpty/);
  assert.match(modelField, /extensions\.subagents\.modelPickEmptyAction/);
  assert.match(modelField, /setSettingsTab\("agent"\)/);
  // No hand-typed model id: the field never renders a free-text input.
  assert.doesNotMatch(modelField, /<Input/);
  assert.doesNotMatch(modelField, /modelPickCustom/);
  assert.match(source, /subagentModelChoices\(providers\)/);
  assert.match(source, /resetSubagentTemplate\(draft\)/);
});

test("the model menu scrolls inside itself and filters, instead of using an OS-drawn list", async () => {
  const picker = await readFile(
    new URL("../src/components/settings/SubagentModelPicker.tsx", import.meta.url),
    "utf8",
  );
  // The anchored surface is what gives the list its own scroll bound; an
  // OS-drawn <select> popup runs off the window instead.
  assert.match(picker, /<AnchoredMenu/);
  assert.match(picker, /provider-service-menu/);
  assert.match(picker, /provider-service-results/);
  // A filter field, so a long list is searchable rather than only scrollable.
  assert.match(picker, /extensions\.subagents\.modelSearch/);
  assert.match(picker, /extensions\.subagents\.modelNoMatches/);
  // Grouped by provider, like the composer and the default-model picker.
  assert.match(picker, /provider-service-group/);
  // Inherit-session is the empty value, so Enter cannot test it for truthiness.
  assert.match(picker, /visibleIds\.includes\(activeId\)/);
});

test("the shared option-menu styles bound the list height and let it scroll", async () => {
  const styles = await readFile(
    new URL("../src/styles/model-config.css", import.meta.url),
    "utf8",
  );
  const results = styles.match(/\.provider-service-results \{([^}]*)\}/);
  assert.ok(results, ".provider-service-results rule is missing");
  assert.match(results[1], /overflow-y:\s*auto/);
  const menu = styles.match(/\.provider-service-menu \{([^}]*)\}/);
  assert.ok(menu, ".provider-service-menu rule is missing");
  assert.match(menu[1], /max-height:/);
});

test("the editor exposes the no-pass thinking option", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
    "utf8",
  );
  const thinkingField = source.slice(
    source.indexOf('label={t("extensions.subagents.thinking")}'),
  );
  assert.match(thinkingField, /id: "omit"/);
  assert.match(thinkingField, /extensions\.subagents\.thinkingOmit/);
  assert.match(thinkingField, /SUBAGENT_THINKING_LEVELS/);
});
