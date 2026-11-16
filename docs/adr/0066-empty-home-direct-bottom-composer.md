# ADR 0066: Empty home direct bottom composer

- Status: Accepted for implementation
- Date: 2026-08-07
- Deciders: PI-Desktop core
- Amends: D111
- Amended by: ADR 0067 (starter-grid presentation only; superseded by D206)

## Context

The empty chat home placed contextual prompt buttons between the hero and the
composer. Those controls added an extra decision before the first task and made
the composer part of the scrollable content stack.

## Decision

1. Remove the former empty-home contextual quick-action row and its
   project-opening buttons.
2. Keep the hero and optional onboarding checklist inside `.home-scroll`, the
   only vertical overflow surface for empty-home content.
3. Render the home composer in a sibling `.home-composer-wrap` after the
   scroller.
4. Preserve the checklist's existing inline actions and dismissal behavior.

## Consequences

- Empty home has one direct task-entry path and a quieter, purpose-built
  guidance surface above it.
- The composer remains stable at the bottom in both empty-home and transcript
  states.
- Optional onboarding remains reachable without an overlay or a second scroll
  surface.
- The former prompt-template row, quick-action styling, and developer starter
  cards are not part of the renderer surface.

## Alternatives considered

### Keep the quick-action row and only move the composer

Rejected. The requested surface is direct task entry; retaining the buttons
would preserve the extra decision layer and its unused prompt-prefill path.

### Keep the composer inside the scroller and align it with `margin-top: auto`

Rejected. Optional checklist growth would still move the composer, and a
short-window overflow could make the primary input less predictable.

### Absolute-position the home composer over the scroller

Rejected. A bottom overlay can cover checklist rows unless every content block
reserves and tracks the composer's changing multi-line height.

## References

- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-063, US-UI-31, US-UI-64)
- `docs/spec/08-meta/decisions-log.md` (D111, D131, D204, D206)
