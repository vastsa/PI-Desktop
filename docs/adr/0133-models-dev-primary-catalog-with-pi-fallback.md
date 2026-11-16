# ADR 0133: Use models.dev as the primary model catalog with pi-ai fallback

- Status: Superseded for chat metadata by [models.dev catalog authority](models-dev-catalog-authority.md)
- Date: 2026-08-29
- Deciders: PI-Desktop core
- Amends: ADR 0027, D136, D243

## Context

PI-Desktop's pinned `@earendil-works/pi-ai` package provides high-quality
runtime adapters and a useful built-in model catalog, but its model coverage and
release cadence do not represent the full current market. Provider settings
therefore cannot reliably offer current model names, limits, modalities, or
capability flags from the catalog users expect.

## Decision

Use `https://models.dev/api.json` as the primary remote model catalog.

1. Electron main fetches the fixed URL with a bounded timeout and parses only
   the provider/model fields needed by PI-Desktop.
2. A models.dev provider is matched by configured `vendorKey` first and by a
   normalized provider API URL second.
3. Catalog precedence for a configured model is: `models.dev` → `pi-ai` →
   provider endpoint discovery → generic defaults.
4. The existing `ModelBinding` remains the explicit user configuration for a
   selected provider/model.
5. The remote snapshot is loaded at most once per Electron process unless an
   explicit future refresh policy replaces it.
6. `ModelInfo.catalogSource` is a renderer-facing annotation only.

Models.dev reasoning options map to the canonical PI-Desktop levels: effort
values are retained when recognized (`none` becomes `off`); toggle and token
budget options use `off` plus `medium` as the enabled representative; a
reasoning record without a level list uses the conservative
`low`/`medium`/`high` set. Entries whose input or output modalities are not text
are not offered in the text agent model picker.

## Consequences

- Settings and Composer can use a current broad provider/model catalog without
  shipping a large static matrix in the application.
- Offline and unavailable-catalog operation remains possible through cached
  provider rows, pi-ai's bundled catalog, provider discovery, and free-form
  model IDs.
- The remote catalog can update names and limits independently of an app
  release, so fixture-based parser and precedence tests are required.
- models.dev does not define provider wire adapters.
- A remote catalog outage is non-fatal and must not erase user-selected bindings
  or credentials.

## Alternatives

### Keep pi-ai as the sole catalog

Rejected because its native catalog is narrower and can lag models.dev's market
coverage, despite remaining the best local fallback and adapter source.

### Fetch models.dev in the renderer

Rejected because catalog loading belongs to Electron main, keeps one network
boundary, and avoids mixing provider credentials or remote response handling
with renderer state.

### Replace provider discovery entirely

Rejected because custom/local endpoints and authenticated vendor catalogs can
expose models not present in a public catalog.

## References

- `apps/desktop/electron/main/models-dev-catalog.ts`
- `apps/desktop/electron/main/index.ts`
- `packages/agent-runtime/src/model-capabilities.ts`
- `docs/spec/03-runtime/11-provider-model-system.md`
- `docs/spec/03-runtime/12-provider-config-schema.md`
- `docs/spec/03-runtime/13-model-catalog-and-selection.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-066, E2E-080, E2E-154)
