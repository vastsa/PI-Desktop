/**
 * Coverage for the subagent output cap (issue #171).
 *
 * A delegate is a bounded worker, so its response length belongs beside its
 * turn limit in the editor's Advanced area rather than in the model binding:
 * the binding caps the session's model for every caller, while this caps one
 * delegate's own responses. The cap has to survive the whole path — editor
 * draft, host record, document frontmatter, parsed definition, built model —
 * and every step of that path is a separate file, so the wiring is asserted
 * where it lives.
 *
 * These tests scan the sources instead of mounting React, like the sibling
 * `subagent-editor-presets.test.mjs`, because the editor needs a renderer
 * harness that desktop unit tests deliberately avoid.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readSharedTypesSource } from "./helpers/source-contracts.mjs";

const editorSource = await readFile(
  new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../src/components/settings/AgentSubagentsPage.tsx", import.meta.url),
  "utf8",
);
const sharedDefinition = await readFile(
  new URL("../../../packages/shared/src/subagent-definition.ts", import.meta.url),
  "utf8",
);
const sharedTypes = await readSharedTypesSource();
const runtimeSource = await readFile(
  new URL("../../../packages/agent-runtime/src/subagent.ts", import.meta.url),
  "utf8",
);
const hostSource = await readFile(
  new URL("../../../crates/host-core/src/user_subagents.rs", import.meta.url),
  "utf8",
);

test("the definition declares the cap and keeps it optional", () => {
  assert.match(sharedDefinition, /maxTokens\?: number;/);
  assert.match(sharedDefinition, /MAX_SUBAGENT_MAX_TOKENS = 200_000;/);
  assert.match(sharedDefinition, /MIN_SUBAGENT_MAX_TOKENS = 1;/);
  // Absent means "follow the model", so the parser must be able to return
  // nothing at all rather than substituting a default cap.
  assert.match(sharedDefinition, /function parseMaxTokens\(/);
  assert.match(sharedDefinition, /const maxTokens = parseMaxTokens\(/);
  assert.match(sharedDefinition, /\.\.\.\(maxTokens !== undefined \? \{ maxTokens \} : \{\}\),/);
});

test("the record and its input expose the cap to the settings API", () => {
  assert.match(sharedTypes, /maxTokens\?: number;/);
  assert.match(
    sharedTypes,
    /\/\*\* `0` clears the cap; absent leaves it unchanged\. \*\//,
  );
});

test("host-core parses, clamps, renders and clears the cap", () => {
  assert.match(hostSource, /const MAX_TOKENS_CEILING: u32 = 200_000;/);
  assert.match(hostSource, /pub max_tokens: Option<u32>,/);
  assert.match(hostSource, /\.get\("maxtokens"\)/);
  assert.match(hostSource, /output\.push_str\(&format!\("maxTokens: \{max_tokens\}\\n"\)\);/);
  // `Some(0) => None` is what lets Settings clear the cap again.
  assert.match(hostSource, /next\.max_tokens = match input\.max_tokens \{/);
});

test("the editor draft round-trips the cap through create, edit and save", () => {
  assert.match(editorSource, /\/\*\*[\s\S]*?maxTokens: number;/);
  assert.match(editorSource, /maxTokens: 0,/);
  assert.match(editorSource, /maxTokens: record\.maxTokens \?\? 0,/);
  assert.match(
    editorSource,
    /maxTokens: Number\.parseInt\(event\.target\.value, 10\) \|\| 0/,
  );
  assert.match(editorSource, /return "extensions\.subagents\.errorMaxTokens";/);
  // The draft value is what the settings API receives.
  assert.match(pageSource, /maxTokens: draft\.maxTokens,/);
});

test("the cap is edited in the existing Advanced area, next to the turn limit", () => {
  assert.match(
    editorSource,
    /function AdvancedFields\(/,
  );
  assert.match(
    editorSource,
    /extensions\.subagents\.maxTurnsUnlimited"\)\}[\s\S]*?extensions\.subagents\.maxTokens"\)/,
  );
  assert.match(
    editorSource,
    /hint=\{t\("extensions\.subagents\.maxTokensHint", \{[\s\S]*?max: MAX_SUBAGENT_MAX_TOKENS\.toLocaleString\(\)/,
  );
  assert.match(editorSource, /max=\{MAX_SUBAGENT_MAX_TOKENS\}/);
  assert.match(
    editorSource,
    /placeholder=\{t\("extensions\.subagents\.maxTokensDefault"\)\}/,
  );
  // Cleared means "follow the model", so the input shows nothing rather than 0.
  assert.match(
    editorSource,
    /value=\{draft\.maxTokens > 0 \? String\(draft\.maxTokens\) : ""\}/,
  );
});

test("the runtime overrides the built model instead of replacing it", () => {
  assert.match(
    runtimeSource,
    /const builtModel = buildProviderModel\(opts\.provider\);/,
  );
  assert.match(
    runtimeSource,
    /opts\.definition\.maxTokens !== undefined[\s\S]*?\{ \.\.\.builtModel, maxTokens: opts\.definition\.maxTokens \}[\s\S]*?: builtModel;/,
  );
  // The provider registry and the omit-thinking path both read `model`, so a
  // cap that bypassed it would silently not apply to the request.
  assert.match(runtimeSource, /createProviderModels\(opts\.provider, model\)/);
});

test("every locale ships the output-cap copy", async () => {
  const locales = ["de", "en", "es", "fr", "ko", "tr", "zh-CN", "zh-TW"];
  for (const locale of locales) {
    const catalog = await readFile(
      new URL(`../../../packages/i18n/src/locales/${locale}/index.ts`, import.meta.url),
      "utf8",
    );
    for (const key of [
      "maxTokens",
      "maxTokensHint",
      "maxTokensDefault",
      "errorMaxTokens",
    ]) {
      assert.match(catalog, new RegExp(`"?${key}"?:`), `${locale} is missing ${key}`);
    }
    // The hint interpolates the ceiling; a dropped placeholder would render a
    // literal `{{max}}` in the editor.
    assert.match(
      catalog,
      /"?maxTokensHint"?:[^\n]*\{\{max\}\}/,
      `${locale} lost the {{max}} placeholder`,
    );
  }
});
