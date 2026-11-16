# ADR 0113: Persist the New Task empty slot immediately and deduplicate it by message count

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** ADR 0084 / D220
- **Related:** D088 · D093 · D305 · E2E-011b · E2E-011d · E2E-011e · E2E-011g
- **Amended by:** ADR 0154 (first-frame empty reveal; reuse without a blocking list refresh)

## Context

ADR 0084 deferred session creation until the first prompt. That removed
abandoned rows, but it also made the New Task action invisible in the sidebar
and removed the scoped empty-session reuse behavior.

## Decision

When New Task is invoked for a project or the path-less Temporary group:

1. Sort that group's non-archived sessions by `updatedAt` descending.
2. If the most recent session is empty (`messageCount = 0` and the renderer has
   no live rows, running turn, or submitted draft), select it and reveal its
   empty transcript on the first frame.
3. Otherwise reveal the empty home on the first frame, create a real empty
   session through `session.create`, and insert the returned summary into the
   sidebar.

Renderer requests for the same group are serialized. This makes rapid repeated
clicks observe the first completed empty slot instead of racing multiple
`session.create` calls.

## Consequences

- New sessions are visible and selectable immediately, before the first user
  message.
- Repeated New Task clicks in one group are idempotent while different project
  groups remain independent.
- An older empty session can remain when a newer non-empty session is the
  group's latest; the rule intentionally considers only that latest session.
- Empty sessions persist until the user deletes or archives them.
- Protocol v9 gains one additive summary field; storage schema v11 and host
  ownership remain unchanged.

## Alternatives considered

- Keep the unpersisted draft from ADR 0084: rejected because the action has no
  immediate sidebar presence and cannot provide a durable ready slot.
- Continue using a default title as the empty predicate: rejected because a
  manual rename changes presentation, not transcript state.
- Add a host-side special `session.createOrReuse` RPC: rejected because the
  existing renderer navigation boundary can enforce the requested grouping rule
  without expanding the host method catalog.
