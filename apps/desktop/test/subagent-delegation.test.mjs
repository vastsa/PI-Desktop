/**
 * The Models page states which models the AI may pick when it delegates, and
 * edits the same `availableForSubagents` opt-in the runtime reads. These tests
 * pin that mapping: the list must never invent a delegation candidate, hide an
 * opt-in the user cannot withdraw, or write a model list that loses another
 * window's edit.
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
  providerServesSubagentDelegation,
  selectedSubagentModels,
  subagentModelCandidates,
  subagentModelOptInDraft,
} = await import("../src/components/settings/subagent-delegation.ts");

const binding = (id, over = {}) => ({
  id,
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
  ...over,
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

test("a service serves delegation exactly when it is enabled with a usable credential", () => {
  assert.equal(providerServesSubagentDelegation(provider()), true);
  assert.equal(providerServesSubagentDelegation(provider({ enabled: false })), false);
  assert.equal(
    providerServesSubagentDelegation(provider({ hasSecret: false, hasOauth: false })),
    false,
  );
  assert.equal(
    providerServesSubagentDelegation(provider({ hasSecret: false, hasOauth: true })),
    true,
  );
  assert.equal(
    providerServesSubagentDelegation(
      provider({ hasSecret: false, hasOauth: false, authKind: "none", baseUrl: "http://127.0.0.1:11434" }),
    ),
    true,
  );
});

test("every configured model is listed in service order with its opt-in state", () => {
  const providers = [
    provider({ models: [binding("a", { availableForSubagents: true }), binding("b")] }),
    provider({ id: "p2", name: "Local", models: [binding("c", { availableForSubagents: true })] }),
  ];
  assert.deepEqual(subagentModelCandidates(providers), [
    { providerId: "p1", providerName: "Anthropic", modelId: "a", label: "a", contextWindow: 128_000, maxTokens: 8_192, selected: true, editable: true },
    { providerId: "p1", providerName: "Anthropic", modelId: "b", label: "b", contextWindow: 128_000, maxTokens: 8_192, selected: false, editable: true },
    { providerId: "p2", providerName: "Local", modelId: "c", label: "c", contextWindow: 128_000, maxTokens: 8_192, selected: true, editable: true },
  ]);
});

test("the alias is the label, and the wire id stays the identity", () => {
  const [candidate] = subagentModelCandidates([
    provider({ models: [binding("claude-haiku-4-5", { alias: "  Quick review " })] }),
  ]);
  assert.equal(candidate.label, "Quick review");
  assert.equal(candidate.modelId, "claude-haiku-4-5");
  // A blank alias falls back to the id rather than rendering an empty row.
  const [blank] = subagentModelCandidates([
    provider({ models: [binding("model-x", { alias: "   " })] }),
  ]);
  assert.equal(blank.label, "model-x");
});

test("an opt-in on a service that is off or has no credential stays visible and withdrawable", () => {
  const disabled = subagentModelCandidates([
    provider({ enabled: false, models: [binding("a", { availableForSubagents: true })] }),
  ]);
  assert.equal(disabled[0].selected, true);
  assert.equal(disabled[0].editable, true);
  assert.equal(disabled[0].blocked, "provider-disabled");

  const keyless = subagentModelCandidates([
    provider({ hasSecret: false, models: [binding("a", { availableForSubagents: true })] }),
  ]);
  assert.equal(keyless[0].editable, true);
  assert.equal(keyless[0].blocked, "credential-missing");

  // A service that is ready carries no reason at all, so the editor adds no note.
  const [ready] = subagentModelCandidates([provider()]);
  assert.equal("blocked" in ready, false);
});

test("an unfamiliar auth kind is judged by the credential it holds, not by its name", () => {
  // Review note on #1758: a future auth flow must not be labelled "no
  // credential" merely because this page does not know its name. The rule reads
  // credential presence, so a stored grant still counts.
  const stored = subagentModelCandidates([
    provider({
      authKind: "device_code",
      hasSecret: true,
      hasOauth: false,
      models: [binding("a")],
    }),
  ]);
  assert.equal("blocked" in stored[0], false);

  // Nothing stored: the runtime cannot obtain a key for it either, so the label
  // states the missing credential instead of guessing at the flow.
  const empty = subagentModelCandidates([
    provider({
      authKind: "device_code",
      hasSecret: false,
      hasOauth: false,
      models: [binding("a")],
    }),
  ]);
  assert.equal(empty[0].blocked, "credential-missing");
  assert.equal(empty[0].editable, true);
});

test("a plugin-owned service is read-only because the RPC refuses it", () => {
  const [candidate] = subagentModelCandidates([
    provider({ ownerPluginId: "acme.catalogue", models: [binding("a", { availableForSubagents: true })] }),
  ]);
  assert.equal(candidate.selected, true);
  assert.equal(candidate.editable, false);
});

test("duplicate and blank ids never become two rows", () => {
  const candidates = subagentModelCandidates([
    provider({
      models: [binding("a", { availableForSubagents: true }), binding("A"), binding("  ")],
    }),
  ]);
  assert.equal(candidates[0].selected, true);
});

test("the list carries the limits a service's own model row shows", () => {
  const [candidate] = subagentModelCandidates([
    provider({
      models: [
        binding("a", {
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          availableForSubagents: true,
        }),
      ],
    }),
  ]);
  assert.equal(candidate.contextWindow, 1_000_000);
  assert.equal(candidate.maxTokens, 128_000);
  assert.equal(candidate.selected, true);
  assert.deepEqual(
    selectedSubagentModels([candidate]).map((entry) => entry.modelId),
    ["a"],
  );
});


test("the write sets the opt-in and clears it by dropping the key", () => {
  const stored = [
    binding("a", { alias: "Fast", contextWindowSource: "user", supportsImages: false }),
    binding("b", { availableForSubagents: false }),
  ];
  const optedIn = subagentModelOptInDraft(stored, "a", true);
  assert.deepEqual(optedIn[0], {
    id: "a",
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: [],
    defaultThinkingLevel: null,
    alias: "Fast",
    contextWindowSource: "user",
    supportsImages: false,
    availableForSubagents: true,
  });
  // The untouched binding keeps its identity, so the RPC does not rewrite it.
  assert.equal(optedIn[1], stored[1]);

  const cleared = subagentModelOptInDraft(optedIn, "a", false);
  // Cleared means absent on the wire, which is what keeps `false` from piling up
  // on records that never wanted delegation.
  assert.equal(cleared[0].availableForSubagents, undefined);
  assert.equal(JSON.stringify(cleared[0]).includes("availableForSubagents"), false);
  assert.equal(cleared[0].alias, "Fast");
});

test("the write matches the wire id case-insensitively and leaves an absent id alone", () => {
  const stored = [binding("Claude-Haiku-4-5")];
  assert.equal(subagentModelOptInDraft(stored, "claude-haiku-4-5", true)[0].availableForSubagents, true);
  const untouched = subagentModelOptInDraft(stored, "not-configured", true);
  assert.equal(untouched[0], stored[0]);
});

test("the page mounts the row and writes the flag through the provider, not a second list", async () => {
  const page = await readFile(
    join(here, "../src/components/settings/ModelConfigPage.tsx"),
    "utf8",
  );
  assert.match(page, /<SubagentModelRow/);
  assert.match(page, /subagentModelCandidates\(providers\)/);
  // The opt-in is the service's own binding field, so the save path must be the
  // provider update that already owns it.
  assert.match(page, /models: subagentModelOptInDraft\(provider\.models/);
  // A plugin-owned row and a vanished model are refused instead of overwritten.
  assert.match(page, /!provider\.ownerPluginId/);
  assert.match(page, /settings\.subagentModelSaveFailed/);

  const row = await readFile(
    join(here, "../src/components/settings/SubagentModelRow.tsx"),
    "utf8",
  );
  // The list reuses the service model list's own parts: same row, same search
  // field, same Advanced button (which opens the editor that holds the opt-in),
  // same remove control. Adding never happens here.
  assert.match(row, /selectedSubagentModels\(candidates\)/);
  assert.match(row, /className="provider-chosen-list"/);
  assert.match(row, /provider-chosen-row-head/);
  assert.match(row, /settings\.searchChosenModels/);
  assert.match(row, /settings\.advanced/);
  assert.match(row, /onEdit\(candidate\.providerId\)/);
  assert.match(row, /settings\.subagentModelRemove/);
  assert.match(row, /settings\.subagentModelPluginManaged/);
  assert.match(row, /settings\.subagentModelProviderDisabled/);
});
