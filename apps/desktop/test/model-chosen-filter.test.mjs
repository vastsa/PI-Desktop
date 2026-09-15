/**
 * The chosen pane's search rule, executed rather than grepped for.
 *
 * The pane header's field is how a long configured list gets narrowed, and the
 * add paths (checkbox, select-all, hand-typed id) ask the same module whether
 * the row they are about to add would land behind that field. Keeping the rule
 * here means the answer is asserted once, for the view and for every add path,
 * instead of only existing as the component's inline filter.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  chosenModelMatches,
  displayNamesById,
  filterChosenModels,
  hidesAddedBinding,
  normalizeChosenQuery,
} from "../src/components/settings/model-chosen-filter.ts";

const rows = [
  { id: "openai/gpt-4o-2024-11-20", displayName: "GPT-4o" },
  { id: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
];

const bindings = [
  { id: "openai/gpt-4o-2024-11-20" },
  { id: "anthropic/claude-sonnet-4-5", alias: "Sonnet (fast)" },
  { id: "my-proxy-7b" },
];

test("an empty query keeps every configured model, in the order it was saved", () => {
  assert.equal(filterChosenModels(bindings, "", rows), bindings);
  assert.equal(filterChosenModels(bindings, "   ", rows), bindings);
});

test("the query matches the id, the alias, and the catalog display name", () => {
  const ids = (query) => filterChosenModels(bindings, query, rows).map((binding) => binding.id);
  assert.deepEqual(ids("GPT-4O"), ["openai/gpt-4o-2024-11-20"]);
  assert.deepEqual(ids("sonnet (fast)"), ["anthropic/claude-sonnet-4-5"]);
  assert.deepEqual(ids("claude sonnet"), ["anthropic/claude-sonnet-4-5"]);
  assert.deepEqual(ids("PROXY"), ["my-proxy-7b"]);
  assert.deepEqual(ids("nothing-here"), []);
});

test("a model the discovery answer never mentioned still matches by its own id", () => {
  // A hand-typed binding, or a provider that went quiet, gets a synthetic row
  // carrying its id as the display name; the filter must not need the catalog.
  const quiet = [{ id: "my-proxy-7b", displayName: "my-proxy-7b" }];
  const ids = (source) => filterChosenModels(bindings, "7b", source).map((binding) => binding.id);
  assert.deepEqual(ids(quiet), ["my-proxy-7b"]);
  assert.deepEqual(ids([]), ["my-proxy-7b"]);
});

test("adding a model drops the filter only when it would land out of view", () => {
  // The row matches, so the filter still shows what was just added: keep it.
  assert.equal(hidesAddedBinding([{ id: "anthropic/claude-sonnet-4-5" }], "claude", rows), false);
  // The row does not match: keeping the filter would add it out of view.
  assert.equal(hidesAddedBinding([{ id: "my-proxy-7b" }], "claude", rows), true);
  // Select-all adds every visible row, so one hidden row is enough to drop it.
  assert.equal(
    hidesAddedBinding(
      [{ id: "anthropic/claude-sonnet-4-5" }, { id: "my-proxy-7b" }],
      "claude",
      rows,
    ),
    true,
  );
  // Nothing added, or nothing typed, means there is no row to protect.
  assert.equal(hidesAddedBinding([], "claude", rows), false);
  assert.equal(hidesAddedBinding([{ id: "my-proxy-7b" }], "  ", rows), false);
});

test("a binding with no alias and no catalog name falls back to its id", () => {
  const displayNames = displayNamesById(rows);
  assert.equal(
    chosenModelMatches({ id: "my-proxy-7b" }, normalizeChosenQuery("7B"), displayNames),
    true,
  );
  assert.equal(
    chosenModelMatches({ id: "my-proxy-7b" }, normalizeChosenQuery("gpt"), displayNames),
    false,
  );
});
