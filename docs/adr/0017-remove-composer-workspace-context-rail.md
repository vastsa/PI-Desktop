# ADR 0017: Remove composer workspace context rail

- Status: Accepted
- Date: 2026-07-26

## Context

D056, D066, D067, and D087 attached a rail to the composer showing the current
project, a Local label, and best-effort Git branch metadata. The project entry
duplicated navigation already in the home hero, sidebar, and Projects
destination, and Local and branch were passive: the renderer showed `main` when
detection returned nothing.

## Decision

Neither composer variant renders project, Local, or branch chrome, and the
composer shell reserves no height, seam, separator, or elevation for it.

Presentation only: project selection, active-workspace persistence, session
project binding, Git branch detection, Projects metadata, and workspace-scoped
tools keep working through their existing non-composer surfaces.

This supersedes the workspace-chip and context-rail portions of D052, D055,
D056, D066, D067, and D087; it is D095 in baseline 0.4.4.

## Consequences

- The composer is one prompt surface in every workspace state and loses its
  composer-local project shortcut.
- Branch metadata stays visible where Projects uses it, without a misleading
  composer fallback.

## Alternatives

- Keep the complete rail: rejected, two values were passive and the project
  action duplicated navigation.
- Keep only the project action: rejected, it preserves composer chrome for an
  action the shell already offers.
- Hide the rail in one variant only: rejected, the layouts would differ and the
  prompt surface would shift when a transcript starts.
