# ADR 0042: Message-scoped inline review cards

- Status: Superseded by ADR 0043
- Date: 2026-08-02
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md) ·
  [E2E-057](../spec/06-delivery/04-e2e-test-plan.md)
- Supersedes: D140's global transcript Review changes entry

## Context

The transcript previously rendered one session-owned Review changes command at
the bottom of the chat. That command summarized the whole dirty working tree,
so it was visually detached from the Write/Edit row that caused the change and
did not tell the user which file to inspect. It also required a panel tab just
to answer a local question about one tool result.

The existing Git diff is already bounded, race-safe, and shared by the Review
tab. The redesign should reuse that source of truth instead of introducing a
second renderer-owned diff or durable ownership map.

## Decision

1. A successful workspace Write/Edit row may render one compact
   `InlineReviewCard` immediately after the row inside the same activity
   disclosure. The card is scoped by the workspace path returned in that tool
   result, so unrelated files and other sessions cannot appear beside it.
2. The card header shows the localized file status for added, modified,
   deleted, renamed, and untracked files plus addition/deletion totals. A
   native button toggles the matching current hunks in place with
   `aria-expanded` and `aria-controls`.
3. Failed, denied, scratch, clean, non-Git, and missing-workspace results do not
   render cards. A background session's card remains attached to its own
   transcript and never appears in the currently visible session. The full
   Review tab remains available as the all-files current-worktree view and
   continues to open from successful workspace artifacts.
4. Remove the session-to-workspace review ownership map. Inline card presence
   is derived from the transcript message, the active workspace, and the
   shared workspace diff; no review-specific persistence or protocol field is
   added.

## Consequences

- The review affordance stays adjacent to the operation that produced it and
  can be used without opening the work panel.
- Added, modified, deleted, renamed, and untracked states use one consistent
  status/count/diff presentation.
- The Review tab remains useful for scanning every current file, while cards
  provide path-scoped inspection in the conversation.
- A card reflects the current bounded working-tree diff for its path. External
  edits or later edits to the same file therefore update the card together
  with the Review tab; the renderer does not invent a second diff timeline.

## Alternatives rejected

- **Keep one global transcript entry:** detached the action from its source row
  and exposed unrelated files in a single summary.
- **Persist a separate per-message patch stream:** duplicates the Git diff
  source of truth, expands the message protocol, and needs new retention and
  invalidation rules for external edits.
- **Open Review for every card click:** adds context switching for a local
  inspection and makes the transcript card depend on panel visibility.
