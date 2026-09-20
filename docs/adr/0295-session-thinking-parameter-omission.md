# ADR 0295: Session thinking-parameter omission

- Status: Accepted
- Date: 2026-09-20
- Deciders: PI-Desktop runtime and UX maintainers
- Amends: ADR 0194, ADR 0144, ADR 0221
- Related: D456, E2E-203a

## Context

Subagents already offer `thinkingLevel: omit` (ADR 0194): the agent bookkeeping
state stays `off`, but the request uses the low-level provider stream so no
thinking override is synthesized. Sessions only accepted the seven canonical
levels. Explicit `off` is not equivalent to omitting the parameter; adapters
often serialize `off` as `reasoning_effort: "none"` or `thinking: disabled`.
Users need that third choice on the Composer model × reasoning menu.

## Decision

1. Persist `omit` as a session `thinkingLevel` alongside the seven canonical
   levels. Model-binding `thinkingLevels` and catalog capability lists remain
   the seven canonical values; `omit` is a client selector, not a published
   capability.
2. The Composer reasoning menu prepends `omit` whenever the selected model
   exposes at least one enabled canonical level. The chip renders the
   canonical string `omit` (ADR 0221). Non-reasoning models keep an `off`-only
   menu.
3. Runtime clamping preserves `omit` on a reasoning model and maps it to `off`
   otherwise. Agent bookkeeping stays `off`; the parent stream uses the same
   low-level omit path as subagents (`thinkingLevelMap.off = null`).
4. Schema v19 rebuilds `sessions` so the CHECK includes `omit`. Handshake protocol version is unchanged.
5. Settings `defaultThinkingLevel` accepts `omit` when the binding enables any
   canonical reasoning level, so new sessions can start without a thinking
   override. Capability chips stay canonical; an off-only binding still
   rejects `omit`.

## Consequences

- Composer can leave the provider adapter's default thinking behavior in
  control without disabling thinking.
- Existing sessions keep their stored canonical levels.
- Subagent inherit of a parent `omit` continues to omit.
- A reasoning model's Settings default can be `omit`; new sessions inherit it.
