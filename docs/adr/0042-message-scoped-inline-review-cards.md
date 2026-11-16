# ADR 0042: Message-scoped inline review cards

- Status: Superseded by ADR 0043
- Date: 2026-08-02
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) · decision D451 · E2E-057
- Supersedes: D140's global transcript Review changes entry

## Context

One session-owned Review changes command summarized the whole dirty working
tree, detached from the Write/Edit row that caused the change.

## Decision

Render one compact `InlineReviewCard` after a successful workspace Write/Edit
row, scoped by the workspace path in that tool result and fed by the existing
bounded Git diff, with no new renderer-owned diff or ownership map.

## Consequences

- Review stayed next to the operation that produced it, without a panel tab.
- A card tracked the live working-tree diff for its path.

Superseded by [ADR 0043](0043-message-owned-review-snapshots-and-rollback.md),
which made review state message-owned.
