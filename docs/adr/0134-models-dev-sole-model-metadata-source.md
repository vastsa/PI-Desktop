# ADR 0134: Use models.dev as the sole model metadata source with a local snapshot

- Status: Superseded for chat metadata by [models.dev catalog authority](models-dev-catalog-authority.md)
- Date: 2026-08-29
- Deciders: PI-Desktop core
- Amends: ADR 0027, ADR 0133, D136, D266

## Context

The first models.dev integration still retained a second model metadata path in
pi-ai. That made it possible for a package upgrade or a provider-specific pi
record to change the model name, capabilities, limits, thinking levels, input
modes, or prices that PI-Desktop presented and sent to the sidecar.

## Decision

`https://models.dev/api.json` is the only model metadata/configuration source.

1. Electron main reads the bundled public document from
   `resources/models.dev/api.json` in development and
   `<resources>/models.dev/api.json` in packaged builds.
2. `scripts/release.mjs <version> --tag` fetches `https://models.dev/api.json`,
   validates it, atomically replaces the checked-in resource, and includes that
   file in the release commit before tagging.
3. On startup, Electron reads the bundled snapshot without network I/O.
4. The parser maps all supported models.dev fields into the existing `ModelInfo`
   and sidecar `ModelConfig`: `id`, `name`, `description`, `family`,
   `attachment`, `reasoning`, `reasoning_options`, `tool_call`,
   `structured_output`, `temperature`, `knowledge`, `release_date`,
   `last_updated`, `modalities.input/output`, `open_weights`, `limit.context` /
   `input` / `output`, `cost` including audio/reasoning/cache/tier prices,
   `interleaved`, `status`, `experimental`, and `provider`.
5. The runtime passes the models.dev `ModelConfig` to pi-ai's selected wire
   adapter. pi-ai remains an implementation dependency for request
   serialization, OAuth login/account availability, and stream handling only;
   its builtin model catalog and model capability functions are not consulted.
6. A model absent from models.dev remains runnable through an explicit generic
   text model shape with conservative limits and no reasoning/vision claims.

Models.dev reasoning mappings retain `effort` values that match the canonical
levels (`none` → `off`), map `toggle`/`budget_tokens` to `off` + `medium`, and
use `low`/`medium`/`high` when a reasoning record has no usable level list.
Input and output modality arrays retain `text`, `image`, `audio`, `video`, and
`pdf`; the current text agent picker excludes models that cannot accept and
produce text, while the raw bundled snapshot keeps those records for future
surfaces.

## Consequences

- Model metadata has one authoritative source and is reproducible offline from
  the checked-in release resource.
- Every release refreshes the catalog before tag creation without requiring a
  database or host-core schema migration.
- Settings can fetch a newer snapshot immediately for the current process; the
  next app launch returns to the bundled release snapshot until a new release is
  shipped.
- Provider bindings remain user-owned selections/overrides; the catalog owns
  published model semantics and the generic fallback owns unknown IDs.
- Models.dev outages preserve the last local snapshot, provider endpoint
  discovery, and explicit custom IDs.

## Alternatives

### Keep pi-ai as a model metadata fallback

Rejected: it creates a second authority and allows package updates to silently
change the model configuration selected by the user.

### Keep a user-data snapshot

Rejected: the release artifact must be reproducible and the user cache would
make different installations use different model configuration.

### Fetch only when a provider dialog opens

Rejected: model capability state is also needed by Composer and runtime launch;
the bundled release snapshot gives all surfaces one deterministic baseline.

## References

- `scripts/release.mjs` (release-time catalog refresh)
- `apps/desktop/resources/models.dev/api.json` (bundled snapshot)
- `apps/desktop/electron/main/models-dev-catalog.ts` (catalog parsing and
  refresh)
- `apps/desktop/electron/main/index.ts` (main-process loading and IPC)
- `apps/desktop/src/components/settings/ModelConfigPage.tsx` (settings refresh
  action)
- `packages/agent-runtime/src/model-capabilities.ts`
- `packages/agent-runtime/src/provider-binding.ts`
- `docs/spec/03-runtime/11-provider-model-system.md`
- `docs/spec/03-runtime/12-provider-config-schema.md`
- `docs/spec/03-runtime/13-model-catalog-and-selection.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-066, E2E-080, E2E-154)
