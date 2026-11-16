# ADR 0066: Empty home direct bottom composer

- Status: Accepted for implementation
- Date: 2026-08-07
- Amends: D111
- Amended by: ADR 0067 (starter-grid presentation only; superseded by D206)

## Context

The empty chat home placed contextual quick actions between the hero and the
composer, adding a decision before the first task and letting optional
onboarding content push the primary task-entry surface away from the bottom of
the chat area.

## Decision

Remove the empty-home quick-action row and its project-opening buttons, along
with the developer starter grid from ADR 0067 (D206). The hero and the optional
onboarding checklist stay inside `.home-scroll`, the only vertical overflow
surface, and the composer renders in a sibling `.home-composer-wrap` that is
flex-fixed at the bottom of `home-main-content` with the existing content width
and bottom spacing. Checklist inline actions and dismissal behave as before;
short windows scroll the checklist but never let the composer cover it.

## Consequences

- Empty home has one direct task-entry path with a quieter guidance surface.
- The composer stays at the bottom in both empty-home and transcript states.
- Onboarding stays reachable without an overlay or a second scroll surface.

## Alternatives considered

- Keep the quick-action row and only move the composer: rejected; the row keeps
  the extra decision layer.
- Position the composer absolutely over the scroller: rejected; the overlay
  covers checklist rows unless every block tracks the composer height.
