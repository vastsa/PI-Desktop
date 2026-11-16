# ADR 0224: Right Panel Tab Strip and Data-Driven Add Menu

- Status: Accepted
- Date: 2026-09-11
- Related issue: #229

## Context

The right work panel used one header menu for both tool launchers and
conversation-opened resources. That made open resources harder to scan, put
close actions far from their tabs, and allowed the menu to become a second
scrolling surface.

## Decision

The work-panel header is a horizontally scrollable tab strip followed by a
fixed, tight `+` trigger. The strip is the only horizontally scrolling region;
the `+` remains visible.

The `+` menu has one **Tools & panels** group. Review is the only host-owned
entry; all other entries come from the current plugin-view metadata returned by
`contributes.views`.

## Consequences

- The tab strip makes the active resource and its close affordance visible while
  preserving panel width and the existing native-surface occlusion boundary.
- The New launcher gives an intentional next action after the last tab closes
  without changing the panel's session-scoped state model.
- Plugin authors automatically receive a panel launcher whenever their scoped
  view contribution is available; the host's built-in list does not drift from
  plugin metadata.
- The larger default gives the header enough room for the 166px Windows/Linux
  titlebar reservation while preserving existing user-selected widths.
