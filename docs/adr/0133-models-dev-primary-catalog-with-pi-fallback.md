# ADR 0133: Use models.dev as the primary model catalog with pi-ai fallback

- Status: Superseded for chat metadata by [models.dev catalog authority](models-dev-catalog-authority.md)
- Date: 2026-08-29
- Amends: ADR 0027, D136, D243

## Context

The pinned `@earendil-works/pi-ai` package offers good runtime adapters and a
useful built-in catalog, but its model coverage and release cadence do not match
the current market. Model metadata must stay outside the renderer, provider
credentials must never reach a catalog service, and custom or local providers
must remain usable when no public catalog knows them.

## Decision

`https://models.dev/api.json` is the primary remote model catalog, fetched and
parsed by Electron main only with a bounded timeout and without any provider
credential.

1. A models.dev provider is matched by configured `vendorKey` first and by a
   normalized provider API URL second; an exact model ID match supplies the
   display name, context and output limits, input modalities, price hints,
   reasoning options, and the tool-call and structured-output flags.
2. Catalog precedence is `models.dev` → `pi-ai` → provider endpoint discovery →
   generic defaults, with pi-ai remaining the adapter-specific fallback and
   discovery covering custom and account-specific ids.
3. The existing `ModelBinding` stays the explicit user configuration: catalog
   data supplies defaults and capability metadata, while binding edits keep
   controlling configured limits and enabled thinking levels.
4. The snapshot loads at most once per Electron process, a failed fetch keeps
   the last successful in-memory snapshot and the Rust-owned provider cache, and
   `ModelInfo.catalogSource` records `models.dev` or `pi-ai` as a
   renderer-facing annotation only.

models.dev reasoning options map to canonical levels — recognized effort values
are kept (`none` becomes `off`), toggle and token-budget options use `off` plus
`medium`, and a reasoning record without a level list uses
`low`/`medium`/`high` — and entries whose modalities are not text are not offered
in the text agent model picker.

## Consequences

- Settings and Composer gain a current broad catalog without a large static
  matrix, and offline operation still works through cached rows, pi-ai,
  discovery, and free-form model ids.
- The catalog can change independently of an app release, so parser and
  precedence fixtures are required, and an outage must never erase
  user-selected bindings or credentials.
- models.dev defines no wire adapters: pi-ai compatibility data still governs
  request serialization, and a catalog entry cannot grant an unsupported
  transport to an unknown id.

## Alternatives

- Keep pi-ai as the sole catalog: its native catalog is narrower and lags
  models.dev coverage.
- Fetch models.dev in the renderer: catalog loading belongs to Electron main,
  which keeps one network boundary and remote handling out of renderer state.
