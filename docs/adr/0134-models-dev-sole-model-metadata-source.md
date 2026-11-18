# ADR 0134: Use models.dev as the sole model metadata source with a local snapshot

- Status: Superseded for chat metadata by
  [models.dev catalog authority](models-dev-catalog-authority.md); amends
  ADR 0027, ADR 0133, D136, D266
- Date: 2026-08-29
- Related: D136, D266, ADR 0027, ADR 0133

## Context

The first models.dev integration still retained a second model metadata path in
pi-ai, so a package upgrade or a provider-specific pi record could change the
model name, capabilities, limits, thinking levels, input modes, or prices that
PI-Desktop presented and sent to the sidecar, and it did not persist the complete
public models.dev document, so model updates depended on the process staying
online.

## Decision

`https://models.dev/api.json` is the only model metadata/configuration source.
Electron main reads the bundled public document from
`resources/models.dev/api.json` in development and `<resources>/models.dev/api.json`
in packaged builds — part of the release artifact, not the user data directory —
and `scripts/release.mjs <version> --tag` fetches, validates, and atomically
replaces that checked-in resource before tagging. Startup reads the snapshot
without network I/O; Settings → Model configuration exposes **Refresh model
catalog**, which refetches the URL into the in-memory snapshot for the current
process only, never writing the packaged file or a user cache. The parser maps
every supported models.dev field into `ModelInfo` and the sidecar `ModelConfig`,
and provider/model matching accepts the configured vendor key, normalized API URL,
catalog provider identity, and unambiguous vendor-prefixed IDs without changing
the user-visible ID. The runtime passes the models.dev `ModelConfig` to pi-ai's
selected wire adapter, leaving pi-ai an implementation dependency for request
serialization, OAuth login and account availability, and stream handling only,
with its builtin model catalog and capability functions unconsulted. A model
absent from models.dev remains runnable through an explicit generic text model
shape with conservative limits and no reasoning or vision claims, and provider
`/models` discovery or authenticated OAuth availability may supply unlisted IDs
but cannot invent metadata.

Reasoning mappings keep `effort` values matching the canonical levels (`none` →
`off`), map `toggle` and `budget_tokens` to `off` plus `medium`, and fall back to
`low`/`medium`/`high` without a usable level list; modality arrays keep `text`,
`image`, `audio`, `video`, and `pdf`, while the text agent picker excludes models
that cannot accept and produce text.

## Consequences

- Model metadata has one authoritative source and is reproducible offline from the
  checked-in release resource, which every release refreshes without a schema
  migration.
- Settings can fetch a newer snapshot for the current process; the next launch
  returns to the bundled release snapshot, and models.dev outages preserve the last
  local snapshot.
- Provider bindings stay user-owned selections and overrides: the catalog owns
  published model semantics and the generic fallback owns unknown IDs.

## Alternatives

- Keep pi-ai as a metadata fallback: it creates a second authority and lets package
  updates silently change the configuration the user selected.
- Keep a user-data snapshot: the release artifact must be reproducible, and a user
  cache would make installations diverge.
