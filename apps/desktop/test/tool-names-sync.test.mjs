import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The canonical tool names, their pre-rename spellings, and the normalization
// cases over them exist twice: once in the Rust host that dispatches tools
// (`crates/host-core/src/tools/names.rs`) and once in the TypeScript shared
// package the runtime and the UI read (`packages/shared/src/tool-names.ts`).
// Nothing type-checks across that boundary, so — like
// `plugin-timeout-budgets.test.mjs` does for the timeout constants — this test
// reads both sources and fails when a name, an alias, or a case is added to one
// side only. The normalization behavior itself is covered by the unit tests
// next to each implementation (`cargo test -p host-core`, the shared package's
// vitest suite); this file pins the two tables together.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path) => readFileSync(join(repoRoot, path), "utf8");

const rustSource = source("crates/host-core/src/tools/names.rs");
// The case table lives in each side's own test module.
const tsSource = source("packages/shared/src/tool-names.ts");
const tsCases = source("packages/shared/src/tool-names.test.ts");

/** The bracketed literal that declares `name`, in either language's syntax. */
function literalBlock(text, name) {
  const declaration = new RegExp(`(?:pub |export )?const ${name}[^=]*=\\s*&?\\[`).exec(text);
  assert.ok(declaration, `${name} is not declared as an array literal`);
  const start = declaration.index + declaration[0].length - 1;
  const end = text.indexOf("];", start);
  assert.ok(end > start, `${name} has no closing bracket`);
  return text.slice(start, end);
}

/** Every `"quoted"` string inside a literal block, in order. */
function stringsIn(block) {
  return [...block.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

/**
 * Every `("a", "b")` / `["a", "b"]` pair inside a literal block, in order.
 *
 * A formatter is free to wrap a long entry over several lines (rustfmt does,
 * with the comma before the closing bracket), and an entry the pattern cannot
 * read would silently drop out of the comparison, so the count has to account
 * for every quoted string in the block.
 */
function pairsIn(block) {
  const entries = block
    .split("\n")
    .filter((line) => !/^\s*(\/\/|#)/.test(line))
    .join("\n");
  const pairs = [...entries.matchAll(/[(\[]\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,?\s*[)\]]/g)].map(
    (match) => [match[1], match[2]],
  );
  assert.equal(
    pairs.length * 2,
    stringsIn(entries).length,
    "a pair entry was not parsed; the literal shape changed",
  );
  return pairs;
}

const rustCanonical = stringsIn(literalBlock(rustSource, "CANONICAL_TOOL_NAMES"));
const tsCanonical = stringsIn(literalBlock(tsSource, "CANONICAL_TOOL_NAMES"));
const rustAliases = pairsIn(literalBlock(rustSource, "LEGACY_TOOL_NAME_ALIASES"));
const tsAliases = pairsIn(literalBlock(tsSource, "LEGACY_TOOL_NAME_ALIASES"));
const rustNormalization = pairsIn(literalBlock(rustSource, "NORMALIZATION_CASES"));
const tsNormalization = pairsIn(literalBlock(tsCases, "NORMALIZATION_CASES"));

test("Rust and TypeScript declare the same canonical tool names, in the same order", () => {
  assert.deepEqual(rustCanonical, tsCanonical);
  assert.ok(rustCanonical.length > 0, "the canonical list is empty");
  assert.equal(new Set(rustCanonical).size, rustCanonical.length, "a name is listed twice");
  for (const name of rustCanonical) {
    // The model-visible name is lowercase snake_case: `task_wait`, not
    // `TaskWait`, so a helper that branches on pi's own lowercase names hits it.
    assert.match(name, /^[a-z0-9_]+$/, `${name} is not lowercase snake_case`);
    assert.ok(!name.startsWith("plugin_") && !name.startsWith("mcp_"), `${name} claims a third-party prefix`);
  }
});

test("both sides map the same legacy spellings to the same canonical names", () => {
  assert.deepEqual(rustAliases, tsAliases);
  assert.ok(rustAliases.length > 0, "the legacy alias table is empty");
  for (const [legacy, canonical] of rustAliases) {
    assert.ok(legacy.length > 0, "an empty legacy name can never be matched");
    assert.ok(rustCanonical.includes(canonical), `${legacy} maps to unknown ${canonical}`);
  }
  // The pre-rename spellings of the multi-word names are not case variants of
  // their canonical form, so they must stay listed explicitly.
  const legacyNames = new Set(rustAliases.map(([legacy]) => legacy));
  for (const name of ["TaskWait", "TaskList", "TaskStop", "BrowserPreview", "EnterPlanMode"]) {
    assert.ok(legacyNames.has(name), `${name} is no longer mapped`);
  }
});

test("both implementations are pinned to the same normalization cases", () => {
  assert.deepEqual(rustNormalization, tsNormalization);
  assert.ok(rustNormalization.length > 0, "the case table is empty");
  for (const [input, expected] of rustNormalization) {
    // A case either resolves to a canonical name, or is a name that is not
    // ours and therefore comes back untouched.
    assert.ok(
      expected === input || rustCanonical.includes(expected),
      `${input} expects ${expected}, which is neither a canonical name nor itself`,
    );
  }
  // Every legacy spelling must be covered by the shared case table too,
  // otherwise one side could drop the alias from its own tests unnoticed.
  for (const [legacy, canonical] of rustAliases) {
    assert.ok(
      rustNormalization.some(([input, expected]) => input === legacy && expected === canonical),
      `${legacy} is missing from NORMALIZATION_CASES`,
    );
  }
  // Names that are not ours: the shell id and the third-party prefixes.
  const remaining = new Set(rustNormalization.map(([input]) => input));
  for (const untouched of ["PowerShell", "plugin_tool"]) {
    assert.ok(remaining.has(untouched), `${untouched} is not covered as an untouched name`);
  }
});
