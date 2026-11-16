# ADR asktool-draft-survives-session-switch: AskTool drafts survive a card remount

- Status: Accepted
- Date: 2026-10-20
- Issues: #1765
- Amends: the "Request transitions" rule in `docs/spec/04-ux/11-asktool-question-card.md`

## Context

The card's question index and draft answers were component state. Switching
sessions unmounts the card — `Composer` renders it only while the active session
has a head ask — so returning to the same pending ask remounted a fresh card at
question one with every answer cleared.

## Decision

Draft answers and the open question index live in the app store, keyed by
`requestId` (`askDrafts`). `AskToolCard` reads and writes that entry instead of
owning `useState`, so unmounting and remounting the same request is harmless.

The draft is dropped when the ask is resolved or dismissed, when its tool call
finishes, when the session's asks are cleared, and when a pending-queue
reconcile removes the ask. Drafts remain renderer memory, like `pendingAsks`;
they are not persisted across an application restart and never leak between
requests.

## Consequences

- Switching sessions and returning to the same pending ask keeps the selected
  options, the custom text, skipped markers, and the open question.
- Resolved, dismissed, and removed asks leave no draft behind.
- `AskToolCard` becomes a controlled view over store state; it keeps no
  draft-local `useState`.
- The "Request transitions" section of the asktool card spec is amended: drafts
  belong to the request, not to the mounted card instance.
