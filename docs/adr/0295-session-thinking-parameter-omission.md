# ADR 0295: Session thinking-parameter omission

- Status: Accepted
- Date: 2026-09-20
- Amends: ADR 0194, ADR 0144, ADR 0221
- Related: D456

## Context

Subagents already offer `thinkingLevel: omit` (ADR 0194): bookkeeping stays `off`
while the request uses the low-level provider stream, so no thinking override is
synthesized. Sessions accepted only the canonical levels, yet explicit `off` is
not equivalent to omission because adapters serialize it as
`reasoning_effort: "none"` or `thinking: disabled`, and users wanted that third
choice on the Composer reasoning menu.

## Decision

A session `thinkingLevel` may persist `omit` alongside the seven canonical levels,
while binding `thinkingLevels` and catalog capability lists stay canonical:
`omit` is a client selector, not a published capability. The Composer reasoning
menu prepends `omit` whenever the selected model exposes at least one enabled
canonical level and stays `off`-only for non-reasoning models, runtime clamping
preserves `omit` on a reasoning model and maps it to `off` otherwise, and the
parent stream uses the same low-level path as subagents
(`thinkingLevelMap.off = null`). Schema v19 rebuilds `sessions` so the CHECK
includes `omit`, the handshake version is unchanged, and Settings
`defaultThinkingLevel` accepts `omit` when the binding enables any canonical
reasoning level.

## Consequences

- Composer can leave the adapter's default thinking behavior in control without
  disabling thinking.
- Existing sessions keep their stored canonical levels, and a subagent inheriting
  a parent `omit` continues to omit.
- A reasoning model's Settings default can be `omit`, which new sessions inherit.
