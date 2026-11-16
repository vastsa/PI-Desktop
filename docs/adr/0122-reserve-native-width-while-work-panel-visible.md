# ADR 0122: Reserve native width while the work panel is visible

- Status: Superseded by ADR 0151
- Date: 2026-08-25
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D255
- Supersedes: ADR 0033; restores the native-reservation behavior from ADR 0032

## Context

The work panel is correctly rendered as an in-flow flex sibling, but the
renderer had started requesting a native reservation of `0` for every state.

## Decision

1. Keep the work panel as a fixed-width in-flow flex column in the renderer.

## Consequences

Superseded (Superseded by ADR 0151). The full record is in git history.
