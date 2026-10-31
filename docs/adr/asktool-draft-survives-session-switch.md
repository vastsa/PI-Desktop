# ADR asktool-draft-survives-session-switch: AskTool drafts survive a card remount

- Status: Accepted
- Date: 2026-10-20
- Issues: #1765
- Amends: the "Request transitions" rule in `docs/spec/04-ux/11-asktool-question-card.md`

## Context

The card's question index and draft answers were component state. Switching
sessions unmounts the card — `Composer` renders it only while the active session
has a head ask — so returning to the same pending ask remounted a fresh card at
question one with every answer cleared. The ask itself survived because it lives
in the store; only the in-progress answers were lost, which made the user redo
the whole card.

The existing specification froze the opposite behavior: "Unsubmitted card drafts
are local to the mounted card and are reset when it is replaced." That rule
predates the session-switch case and no longer matches what users expect.

## Decision

Draft answers and the open question index live in the app store, keyed by
`requestId` (`askDrafts`). `AskToolCard` reads and writes that entry instead of
owning `useState`, so unmounting and remounting the same request is harmless.
A missing entry falls back lazily to an empty draft at read time; the card does
not seed the store during render.

The draft is dropped when the ask is resolved or dismissed, when its tool call
finishes, when the session's asks are cleared, and when a pending-queue reconcile
removes the ask. Drafts remain renderer memory, like `pendingAsks`; they are not
persisted across an application restart and never leak between requests.

## Consequences

- Switching sessions and returning to the same pending ask keeps the selected
  options, the custom text, skipped markers, and the open question.
- Resolved, dismissed, and removed asks leave no draft behind.
- `AskToolCard` becomes a controlled view over store state; it keeps no
  draft-local `useState`.
- The "Request transitions" section of the asktool card spec is amended: drafts
  belong to the request, not to the mounted card instance.

## Validation

`pnpm test:e2e:asktool-card` adds `E2E-ASKTOOL-draft-survives-session-switch`:
it selects an option, advances to question two, unmounts the card, remounts the
same `requestId`, and asserts the open question and the earlier selection
survive. The existing compact-card flows keep passing. `pnpm typecheck` and
`pnpm lint` cover the renderer types and style tokens.
