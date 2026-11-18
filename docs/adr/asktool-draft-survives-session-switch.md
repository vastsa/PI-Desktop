# ADR asktool-draft-survives-session-switch: AskTool drafts survive a card remount

- Status: Accepted
- Date: 2026-10-20
- Issues: #1765
- Amends: the "Request transitions" rule in `docs/spec/04-ux/11-asktool-question-card.md`

## Context

The card's question index and draft answers were component state, but `Composer`
renders the card only while the active session has a head ask, so a session
switch unmounted it and returning to the same pending ask remounted a fresh card
at question one with every answer cleared. The spec froze that opposite behavior
by treating drafts as local to the mounted card.

## Decision

Draft answers and the open question index live in the app store keyed by
`requestId` (`askDrafts`), and `AskToolCard` reads and writes that entry instead
of owning `useState`, so unmounting and remounting the same request is harmless
and a missing entry falls back lazily to an empty draft without seeding the store
during render. The draft is dropped when the ask is resolved or dismissed, when
its tool call finishes, when the session's asks are cleared, and when a
pending-queue reconcile removes the ask; drafts stay renderer memory like
`pendingAsks`, are not persisted across a restart, and never leak between
requests.

## Consequences

- Returning to the same pending ask keeps the selected options, custom text,
  skipped markers, and open question.
- `AskToolCard` becomes a controlled view over store state with no draft-local
  `useState`, and resolved, dismissed, or removed asks leave no draft behind.
- The "Request transitions" rule is amended: drafts belong to the request, not to
  the mounted card instance.
