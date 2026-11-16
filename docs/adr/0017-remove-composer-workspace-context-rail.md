# ADR 0017: Remove composer workspace context rail

- Status: Accepted
- Date: 2026-07-26

## Context

D056, D066, D067, and D087 established a composer-attached rail that displayed
the current project, a Local environment label, and best-effort Git branch
metadata. Later visual refinements also assigned dedicated height, spacing,
surface, and elevation rules to that rail.

## Decision

The home and thread-docked composer variants never render project, Local, or
branch context chrome. The composer shell reserves no height, seam, separator,
or elevation for the removed rail.

This decision changes presentation only. Project selection, active-workspace
persistence, session project binding, Git branch detection, Projects metadata,
and workspace-scoped tools remain unchanged and available through their existing
non-composer surfaces.

## Consequences

- The composer is a single prompt surface in every workspace state.
- Project selection no longer has a composer-local shortcut.
- Existing project navigation continues through the home hero, sidebar, and
  Projects destination.
- Branch metadata remains visible where Projects uses it, without a misleading
  composer fallback.
- Specs and visual regression scenarios assert the rail's absence.

## Alternatives

### Keep the complete rail

Rejected because two of its three values were passive and the project action
duplicated existing navigation.

### Keep only the project action

Rejected because it would preserve a dedicated composer surface for an action
already available in the surrounding shell.

### Hide the rail only in one composer variant

Rejected because inconsistent home and thread layouts would retain extra chrome
and make the prompt surface shift when a transcript starts.

## References

- `docs/spec/00-baseline.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D095)
