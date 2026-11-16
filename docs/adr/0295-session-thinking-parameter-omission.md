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
levels.

## Decision

1. Persist `omit` as a session `thinkingLevel` alongside the seven canonical
   levels.
2. The Composer reasoning menu prepends `omit` whenever the selected model
   exposes at least one enabled canonical level.
3. Runtime clamping preserves `omit` on a reasoning model and maps it to `off`
   otherwise.
4. Schema v19 rebuilds `sessions` so the CHECK includes `omit`.
5. Settings `defaultThinkingLevel` accepts `omit` when the binding enables any
   canonical reasoning level, so new sessions can start without a thinking
   override.

## Consequences

- Composer can leave the provider adapter's default thinking behavior in control
  without disabling thinking.
- Existing sessions keep their stored canonical levels.
- Subagent inherit of a parent `omit` continues to omit.
- A reasoning model's Settings default can be `omit`; new sessions inherit it.
