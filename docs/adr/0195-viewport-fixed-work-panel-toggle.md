# ADR 0195: Viewport-fixed work panel toggle

- Status: Accepted
- Date: 2026-09-09
- Amends: ADR 0068, ADR 0085, D128, D207, D221
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md)

## Context

ADR 0068 restored `Cmd/Ctrl + J` as a renderer-local way to reveal a session's
retained work-panel context and ADR 0085 made it a toggle, but pointer users had
no equivalent: the panel opened from an artifact or the chord and collapse lived
in the panel header, leaving the surface undiscoverable without the shortcut.

## Decision

AppShell owns one viewport-fixed toggle in the top-right corner of every
non-Settings route as the pointer equivalent of `openWorkPanel`: it reveals the
active session's retained context without creating a tab, collapses a visible
panel without deleting tabs, and is disabled with no active session, while
Settings keeps neither panel nor toggle. The button prefers the visible
presentation over a briefly stale store projection, follows both store state and
the presented panel in `aria-pressed`, and is the sole panel-level collapse
control, leaving resource close in the panel header. Windows and Linux window
controls stay viewport-fixed at the window's right edge, the open panel header
reserves their band plus the toggle, and no host protocol, IPC channel, or native
menu command is added.

## Consequences

- Pointer users can find and dismiss the work panel without a shortcut.
- Artifact-driven tab creation, session-scoped contexts, and startup-closed
  behavior from D128 / D142 are unchanged.
- On Windows and Linux the panel header is no longer a full-width action row
  while the panel is open.

## Alternatives considered

- Add a closed-state titlebar button beside the header chevron: two collapse
  controls would occupy the same corner.
- Leave window controls in-flow in MainPane: they would split from the
  viewport-fixed toggle during the dock animation.
