# ADR: Show pinned conversations in a global sidebar section

- Status: Accepted
- Date: 2026-09-13
- Related: [#306](https://github.com/vastsa/PI-Desktop/issues/306) · E2E-SIDEBAR-global-pinned-conversations
- Amends: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md)

## Context

Conversation sorting puts pinned rows first, but project rendering then files them
into chronological buckets, so an older pin can sit below today's unpinned
conversations, and pins vanish when their project tab is collapsed or closed.

## Decision

Render one global Pinned section above standalone Sessions and Projects, derived
from existing session summaries and organization metadata rather than a second pin
registry, including sessions whose project tab is not retained. Archive visibility
applies to both the session and its owning project, while closed or collapsed
projects do not hide otherwise visible pins. Each pin shows its project context and
uses the existing session sort without date buckets, and pinned rows leave the
ordinary rows before chronological grouping and the per-project row limit, though
project membership stays intact for activity ordering and archive navigation. Rows
reuse ordinary selection and actions, unpinning returns a session to its normal
history location and restores focus to its relocated overflow control, and an empty
section is omitted.

## Consequences

- Pins stay discoverable across dates and projects without duplicate rows.
- Existing persisted pins take effect with no storage migration, IPC change, or
  host ownership change.
- Project context costs row width, so it is ellipsized under the title.
