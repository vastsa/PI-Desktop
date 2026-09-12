# ADR 0224: Right Panel Tab Strip and Data-Driven Add Menu

- Status: Accepted
- Date: 2026-09-11
- Related issue: #229

## Context

The right work panel used one header menu for both tool launchers and
conversation-opened resources. That made open resources harder to scan, put
close actions far from their tabs, and allowed the menu to become a second
scrolling surface. The issue's HTML demo establishes the intended structure
and interaction shape, but its simulated content is not an application data
source.

## Decision

The work-panel header is a horizontally scrollable tab strip followed by a
fixed, tight `+` trigger. The strip is the only horizontally scrolling region;
the `+` remains visible. Every open Review, file, or plugin view is represented
by one ARIA tab. Tabs activate on click, close on their hover/focus close
button or middle-click, and support ArrowLeft/ArrowRight/Home/End plus
Delete/Backspace. Closing the final tab keeps the panel open and shows a New
launcher in the body.

The `+` menu has one **Tools & panels** group. Review is the only host-owned
entry; all other entries come from the current plugin-view metadata returned by
`contributes.views`. The renderer must not hardcode bundled Files or Browser
entries, and must not show shortcut labels unless the corresponding binding is
actually registered. Open plugin views remain singleton tabs and reopening one
activates its existing tab.

The viewport-fixed panel toggle remains the sole collapse control. It uses the
two-state panel icon, `aria-pressed`, and a localized tooltip/accessibility name
that includes the user's resolved `Mod+J` binding when one exists. The binding
remains customizable through the existing keyboard-shortcut machinery.

The new-profile default panel width is 360px within the existing 244–720px
range. A saved width is not rewritten by this change. No protocol, persisted
tab schema, plugin manifest, or native-window reservation is introduced.

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
