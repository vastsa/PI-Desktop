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
the bottom of the chat.

## Decision

1. A successful workspace Write/Edit row may render one compact
   `InlineReviewCard` immediately after the row inside the same activity
   disclosure. The card is scoped by the workspace path returned in that tool
   result, so unrelated files and other sessions cannot appear beside it.

## Consequences

Superseded (Superseded by ADR 0043). The full record is in git history.
