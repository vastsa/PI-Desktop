# ADR 0144: Allow User-Configured Thinking-Level Overrides

- Status: Accepted
- Date: 2026-09-01
- Deciders: PI-Desktop core
- Updates ADR 0114 and ADR 0134

## Context

The provider model list combines published model metadata with a persisted
`ModelBinding`. Electron main applied the binding before returning `ModelInfo`
to Settings. An existing binding with no enabled thinking levels therefore
made a models.dev reasoning record look non-reasoning, even when the catalog
correctly described the model as reasoning-capable.

The same intersection also prevented a compatible proxy or newly released
model from being configured when its endpoint supported a thinking level that
the current catalog snapshot did not publish.

## Decision

Keep `ModelInfo` as the raw published models.dev record. Stored binding values
must not rewrite its published reasoning fields or capability tags. Effective
provider and session capability is resolved separately from the exact
`ModelBinding` for the selected model.

The Settings picker always renders the seven canonical thinking levels:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Published levels
seed a newly added known-model binding. For a non-reasoning or unknown model,
the same choices are shown unselected with a concise manual-override hint.
Explicit user selections are saved unchanged and are not intersected with the
models.dev list. An empty binding or a binding containing only `off` means
thinking is disabled; at least one non-`off` selection enables reasoning for
that provider/model.

Composer resolves the selected model's exact binding before rendering its
reasoning menu. Runtime clamping uses the binding's enabled levels. This is an
explicit endpoint configuration, not an automatic claim that the upstream
model supports the selected level; the user is responsible for choosing levels
accepted by a proxy or endpoint.

## Consequences

- Correct models.dev reasoning metadata remains visible in Settings, including
  when an older or manually cleared binding exists.
- OpenAI-compatible proxies and newly released models can opt into thinking
  without waiting for a catalog update.
- Catalog metadata remains the sole source of published model facts; it only
  seeds defaults and does not silently erase explicit endpoint configuration.
- No IPC, storage schema, or host protocol change is required.
- An endpoint may reject an explicitly enabled level; the desktop does not
  infer or guarantee upstream support from the user's selection.

## Alternatives considered

- Treat models.dev as an absolute thinking capability gate: rejected because it
  made valid proxy configurations impossible and caused stored bindings to
  hide published reasoning metadata.
- Mark every OpenAI-compatible model as reasoning-capable automatically:
  rejected because compatibility endpoints differ and discovery must not infer
  unsupported behavior.
- Add a separate per-model "Enable thinking" boolean: rejected because the
  existing `thinkingLevels` set already expresses both the enabled levels and
  the deterministic default.
