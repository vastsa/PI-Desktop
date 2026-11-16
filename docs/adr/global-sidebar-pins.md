# ADR: Show pinned conversations in a global sidebar section

- Status: Accepted
- Date: 2026-09-13
- Related issue: [#306](https://github.com/vastsa/PI-Desktop/issues/306)
- Amends: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md)

## Context

Conversation sorting puts pinned rows first, but project rendering then places
them in chronological buckets. An older pin can therefore appear below today's
unpinned conversations.

## Decision

- Render one global Pinned section above standalone Sessions and Projects.
- Apply archive visibility to both the session and its owning project.
- Show project context on each pin and use the existing session sort within the
  section without date buckets.
- Remove visible pins from ordinary rows before chronological grouping and the
  per-project ten-row limit.
- Reuse ordinary row selection and actions.
- Omit an empty section and bound its scroll area to `min(224px, 30vh)`.

## Consequences

Pins remain discoverable across dates and projects without duplicate rows.
