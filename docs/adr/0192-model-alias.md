# ADR 0192: Alias a configured model and make model ids copyable

- Status: Accepted
- Date: 2026-09-08
- Deciders: PI-Desktop renderer and UX maintainers
- Amends: D266
- Related: E2E-201

## Context

Settings → Model configuration lists models by their wire id, while the composer
shows the catalog's published `displayName`. Two gaps surfaced in daily use:

1. One provider row can carry several models with near-identical published
   names, and a user cannot attach a short personal label ("fast", "pro") to one
   of them.
2. Model ids in the configuration page could not be copied.

## Decision

1. `ModelBinding` gains an optional `alias?: string`, persisted with the
   provider's `models` array.
2. The alias is edited in the selected model's Advanced body and shown as a chip
   beside the id in the selected-model row.
3. Where the composer names a model, a non-empty trimmed alias replaces the
   published display name.
4. Model ids and names in the configuration page opt back into text selection
   (`.selectable`).
5. Host-core persists and normalizes the alias inside the existing provider
   `config_json` `models` array: a blank or absent alias is dropped, and an
   alias longer than 60 characters is rejected with `MODEL_ALIAS_TOO_LONG`.

## Consequences

- One provider can host several models under short personal labels without
  renaming anything the catalog owns.
- The composer, its search, and the model picker show the alias, while the
  configuration page and the transcript badge keep the real id, so a mistyped
  alias cannot hide which model will be called.
- Copying a model id no longer requires retyping it by hand.

## Rejected alternatives

- **Rename `displayName` on the binding:** duplicates catalog data and loses the
  published name once the alias is cleared.
- **A separate alias registry keyed by model id:** an alias belongs to one
  provider row's configuration; a global map would collide across providers that
  serve the same id.
- **Make the whole row selectable and drop click-to-toggle:** removes the fast
  multi-select gesture the page is built around.
