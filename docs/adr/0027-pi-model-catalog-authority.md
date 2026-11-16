# ADR 0027: Make pi-ai authoritative for model metadata

- Status: Superseded for chat metadata by [models.dev catalog authority](models-dev-catalog-authority.md)
- Date: 2026-07-27

## Context

PI-Desktop read reasoning hints from pi-ai but rebuilt a smaller runtime model
with desktop defaults and provider overrides, so known models lost their context
window, output limit, input modes, pricing, headers, and parts of their
compatibility record. Two owners of model behavior also forced per-model patches
such as MiMo thinking dialects.

## Decision

For every model resolved from pi-ai's built-in catalog, pi-ai is the sole
authority for metadata and compatibility behavior. Electron main resolves one
complete serializable pi model snapshot (name, base URL, reasoning flag,
thinking-level map, input modes, pricing, context window, output limit, headers,
compatibility data) that the sidecar uses verbatim, replacing only the connection
identity: model id, provider id, API adapter, and an explicitly configured
endpoint URL. PI-Desktop rewrites no reasoning, thinking levels, limits,
temperature, or compatibility flags, and Provider Settings expose no
model-parameter overrides; corrections to a known model belong upstream in pi-ai.
A free-form model id pi does not recognize stays a generic text-only,
non-reasoning fallback with conservative limits, and cached or discovered lists
remain selection data. This supersedes D102 and the provider-override clauses of
D096/D107 (D136) without changing ADR 0018's thinking-level enum or transcript
handling.

## Consequences

- Known models keep the metadata of the pinned pi-ai version across native and
  compatible endpoints, with one less model matrix to maintain.
- A pi-ai upgrade may intentionally change levels or limits, so catalog
  resolution needs tests.
- Legacy override fields stay readable but no longer affect resolution, and
  unknown models are text-only until pi knows them.

## Alternatives

- Merge provider overrides over pi metadata: keeps dual ownership and unsupported
  combinations.
- Reject unknown model ids: turns the catalog into a closed allowlist.
