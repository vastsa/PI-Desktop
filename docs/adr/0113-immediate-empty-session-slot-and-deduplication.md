# ADR 0113: Persist the New Task empty slot immediately and deduplicate it by message count

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** ADR 0084 / D220
- **Related:** D088 · D093 · D305
- **Amended by:** ADR 0154 (first-frame empty reveal; reuse without a blocking list refresh)

## Context

ADR 0084 deferred session creation until the first prompt, which removed abandoned
rows but made New Task invisible in the sidebar and dropped the scoped
empty-session reuse behavior. The product now needs a real, immediately visible
empty session with one empty slot per project or Temporary group. Titles cannot
define emptiness, but the host already stores the message count in
`sessions.last_seq`.

## Decision

New Task sorts the group's non-archived sessions by `updatedAt` descending. If the
latest is empty — `messageCount = 0` with no live renderer rows, running turn, or
submitted draft — the renderer selects it and reveals its transcript on the first
frame, treating a click on the active row as a no-op; otherwise it reveals the
empty home, creates a session through `session.create`, and inserts the returned
summary without blocking on `session.list` / `session.get` (ADR 0154). Requests
for one group are serialized, so rapid clicks observe the first completed slot
instead of racing `session.create` calls.

`SessionSummary.messageCount` is added to the shared IPC/session contract as an
additive field derived from `sessions.last_seq`, keeping protocol v9 and storage
schema v11 compatible. The startup home remains an unpersisted renderer draft;
only explicit New Task creates or reuses the durable slot.

## Consequences

- New sessions are visible and selectable before the first message, and repeated
  clicks in one group are idempotent while groups stay independent.
- Empty sessions persist until deleted or archived, and an older empty session
  can remain when the newest session in the group is non-empty.
- Protocol v9 gains one additive summary field; storage schema v11 and host
  ownership are unchanged.

## Alternatives considered

- Keep the unpersisted draft from ADR 0084: the action has no immediate sidebar
  presence and cannot provide a durable ready slot.
- Use a default title as the empty predicate: a rename changes presentation, not
  transcript state.
