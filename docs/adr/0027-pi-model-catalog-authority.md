# ADR 0027: Make pi-ai authoritative for model metadata

- Status: Superseded for chat metadata by [models.dev catalog authority](models-dev-catalog-authority.md)
- Date: 2026-07-27

## Context

PI-Desktop previously read reasoning hints from pi-ai but rebuilt a smaller
runtime model with desktop-owned defaults and provider-level overrides. Known
models therefore lost pi's context window, output limit, input modes, pricing,
headers, and parts of their compatibility record. Settings also allowed users
to replace reasoning support, thinking levels, context size, output size, and
temperature independently from the selected model.

That split ownership made model behavior depend on two configurations. It also
required PI-Desktop to patch individual model semantics such as MiMo thinking
dialects and adaptive Claude off behavior.

## Decision

For every model resolved from pi-ai's built-in catalog, pi-ai is the sole
authority for model metadata and compatibility behavior.

- Electron main resolves one complete serializable pi model snapshot: name,
  base URL, reasoning flag, thinking-level map, input modes, pricing, context
  window, output limit, headers, and compatibility data.
- The sidecar uses that snapshot verbatim and replaces only the runtime
  connection identity: selected model id, configured provider id, selected API
  adapter, and an explicitly configured endpoint URL.
- PI-Desktop does not rewrite known-model reasoning support, thinking levels,
  context limits, output limits, temperature, or compatibility flags.
- Provider Settings no longer expose model-parameter overrides, and the model
  menu no longer enables reasoning for an unknown model.
- A free-form model id that pi does not recognize remains allowed. It uses an
  explicit generic text-only, non-reasoning fallback with conservative runtime
  limits. This preserves the open custom-provider path without claiming model
  capabilities that pi has not published.
- Cached/discovered model lists remain selection and offline-discovery data;
  they do not override runtime model semantics.
- Corrections to a known model belong upstream in pi-ai or in a pi-ai upgrade,
  not in a PI-Desktop model-specific patch.

This supersedes D102 and the provider-override clauses of D096/D107. It does
not change the durable session thinking-level enum or transcript handling from
ADR 0018.

## Consequences

- Known models retain the complete metadata shipped by the pinned pi-ai
  version across native and compatible endpoints.
- PI-Desktop has one less model matrix to maintain and cannot drift silently
  from pi's adapters.
- Updating pi-ai may intentionally change available thinking levels or model
  limits and must be covered by catalog-resolution tests.
- Unknown custom models remain usable for text, but model-specific reasoning,
  vision, pricing, and large-context guarantees wait until pi recognizes them.
- Legacy provider override fields may remain readable in persisted records for
  compatibility, but they no longer affect runtime resolution.

## Alternatives

### Merge provider overrides over pi metadata

Rejected because it preserves dual ownership and can produce combinations the
selected adapter or model does not support.

### Keep only thinking compatibility from pi

Rejected because it continues discarding context, output, input, pricing, and
other model-specific fields.

### Reject unknown model ids

Rejected because it would violate the product's free-form custom-provider
policy and turn the bundled catalog into a closed allowlist.

## References

- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/11-provider-model-system.md`
- `docs/spec/03-runtime/12-provider-config-schema.md`
- `docs/spec/03-runtime/13-model-catalog-and-selection.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D136)
