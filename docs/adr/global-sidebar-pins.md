# ADR: Show pinned conversations in a global sidebar section

- Status: Accepted
- Date: 2026-09-13
- Related issue: [#306](https://github.com/vastsa/PI-Desktop/issues/306)
- Amends: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md)

## Context

Conversation sorting puts pinned rows first, but project rendering then places
them in chronological buckets. An older pin can therefore appear below today's
unpinned conversations. Pins also disappear when their project tab is collapsed
or closed, which defeats their role as quick access to frequently used sessions.

## Decision

- Render one global Pinned section above standalone Sessions and Projects.
  Derive it from existing session summaries and organization metadata, including
  sessions whose project tab is not retained. Do not create another pin registry.
- Apply archive visibility to both the session and its owning project. Closed
  and collapsed projects do not hide otherwise visible pins.
- Show project context on each pin and use the existing session sort within the
  section without date buckets. Keep project pinning and project sorting intact.
- Remove visible pins from ordinary rows before chronological grouping and the
  per-project ten-row limit. Preserve full project membership for activity
  ordering, archive/delete navigation, and workspace ownership.
- Reuse ordinary row selection and actions. Unpinning returns a session to its
  normal history location and visibility rules. Restore focus to its relocated
  overflow control, with the Sessions sort control as a fallback when hidden.
- Omit an empty section and bound its scroll area to `min(224px, 30vh)`.

## Consequences

Pins remain discoverable across dates and projects without duplicate rows.
Existing persisted pins take effect automatically; no storage migration, IPC
change, or host ownership change is required. Rendering project context costs
some row width, so it is ellipsized and subordinate to the session title.

## Validation

Pure grouping tests cover old, temporary, closed-project, archived, deleted,
unbound, and unpinned sessions. Sidebar rendering coverage checks actual section
order, uniqueness, project folding, archive visibility, and the history limit.
The interaction contract is E2E-SIDEBAR-global-pinned-conversations.
