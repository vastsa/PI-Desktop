/**
 * The search rule behind the chosen pane of the shared model picker.
 *
 * It lives outside the component for two reasons. The pane header's field is
 * the only way to narrow a long configured list, and the add paths need the
 * same answer to a different question: would a model that is being added land
 * behind the filter the user typed earlier? One implementation, executed by
 * `test/model-chosen-filter.test.mjs`, covers both.
 */

/** The slice of a discovery row the rule needs: an id and what it is called. */
export type ChosenFilterRow = {
  id: string;
  displayName: string;
};

/** The slice of a binding the rule needs. */
export type ChosenFilterBinding = {
  id: string;
  alias?: string;
};

/** The typed query, normalized; an empty string means "no filter". */
export function normalizeChosenQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Display names by lowercased model id. The discovered list supplies the
 * catalog's friendly name, so searching "GPT-4o" still finds a binding stored
 * under its full versioned id. A binding the discovery answer never mentioned
 * has no entry here and falls back to matching its own id.
 */
export function displayNamesById(rows: ChosenFilterRow[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const row of rows) byId.set(row.id.toLowerCase(), row.displayName);
  return byId;
}

/**
 * Case-insensitive substring match over what the user can recognise a row by:
 * the model id, its alias, and the catalog display name. An empty query matches
 * everything.
 */
export function chosenModelMatches(
  binding: ChosenFilterBinding,
  normalizedQuery: string,
  displayNames: Map<string, string>,
): boolean {
  if (!normalizedQuery) return true;
  const key = binding.id.toLowerCase();
  return (
    key.includes(normalizedQuery) ||
    (binding.alias?.toLowerCase().includes(normalizedQuery) ?? false) ||
    (displayNames.get(key)?.toLowerCase().includes(normalizedQuery) ?? false)
  );
}

/**
 * The configured bindings the header search keeps on screen. An empty query
 * returns the list itself, so the unfiltered pane costs nothing.
 */
export function filterChosenModels<T extends ChosenFilterBinding>(
  bindings: T[],
  query: string,
  rows: ChosenFilterRow[],
): T[] {
  const needle = normalizeChosenQuery(query);
  if (!needle) return bindings;
  const displayNames = displayNamesById(rows);
  return bindings.filter((binding) =>
    chosenModelMatches(binding, needle, displayNames),
  );
}

/**
 * Whether adding these bindings would leave any of them hidden behind the
 * filter currently in the field. The pane drops the filter when it would, so a
 * model the user just added is never added out of view; a filter that survives
 * is one that still shows what was added.
 */
export function hidesAddedBinding(
  added: ChosenFilterBinding[],
  query: string,
  rows: ChosenFilterRow[],
): boolean {
  const needle = normalizeChosenQuery(query);
  if (!needle || added.length === 0) return false;
  const displayNames = displayNamesById(rows);
  return added.some((binding) => !chosenModelMatches(binding, needle, displayNames));
}
