# ADR 0122: Reserve native width while the work panel is visible

- Status: Superseded by ADR 0151
- Date: 2026-08-25
- Related: D255
- Supersedes: ADR 0033; restores the native-reservation behavior from ADR 0032

## Context

The work panel rendered correctly as an in-flow flex sibling, but the renderer
requested a native reservation of zero in every state, so a collapsed panel left
the window at its larger size and chat expanded into the released column.

## Decision

Request a native reservation equal to the panel's committed width through
`window/setWorkPanelReservation` before showing it opened, keep the panel mounted
through its exit animation, then request zero width and unmount only after the
request succeeds. The Browser `WebContentsView` kept being positioned from the
renderer-measured panel rectangle, and Main kept capping the added width on a
constrained work area.

ADR 0151 supersedes this record and owns current work panel sizing.
