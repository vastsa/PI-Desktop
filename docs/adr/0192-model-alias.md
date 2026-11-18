# ADR 0192: Alias a configured model and make model ids copyable

- Status: Accepted
- Date: 2026-09-08
- Amends: D266

## Context

Settings lists models by wire id while the composer shows the catalog's published
`displayName`, so a user cannot attach a short personal label to one model, and
model ids could not be copied because the shell disables text selection
globally and the id sits inside a row `<label>`.

## Decision

`ModelBinding` gains an optional `alias?: string` persisted with the provider's
`models` array as a display label only, while `id` remains the wire identity.
The alias is edited in the selected model's Advanced body, shown as a chip beside
the id, and used wherever the composer names a model when it is non-empty after
trimming; an absent or blank alias leaves the published name unchanged. Model
ids and names in the configuration page opt back into text selection so
drag-to-copy and click-to-toggle coexist. Host-core normalizes the alias inside
the existing provider `config_json` `models` array, dropping blanks and
rejecting an alias longer than 60 characters with `MODEL_ALIAS_TOO_LONG`, with
no protocol, RPC, or schema change.

## Consequences

- One provider can host several models under short personal labels without
  renaming anything the catalog owns.
- The composer, its search, and the model picker show the alias, while the
  configuration page and transcript badge keep the real id.
- Storage schema stays v13 and copying a model id no longer requires retyping.

## Rejected alternatives

- Rename `displayName` on the binding: it duplicates catalog data and loses the
  published name once the alias is cleared.
- A separate alias registry keyed by model id: aliases belong to one provider
  row and would collide across providers serving the same id.
