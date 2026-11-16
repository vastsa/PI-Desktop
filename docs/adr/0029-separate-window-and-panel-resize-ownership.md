# ADR 0029: Separate native-window and work-panel resize ownership

- Status: Superseded in part by ADR 0032 (the clamp of the panel inside the
  existing client area and the ban on panel-driven native geometry)
- Date: 2026-07-28
- Related: D156

## Context

Panel visibility and divider commits called `window/resizeBy` so Electron could
resize the native window, while renderer `window.resize` events inferred a
right-edge gesture and wrote part of that delta back into the panel width. The
panel changed the native window and the native window changed the panel,
producing a second layout jump after divider release, stale growth on rapid
open/close, and preferences mutated during an unrelated resize.

## Decision

1. Electron Main exclusively owns `BrowserWindow` bounds and persists the actual
   normal bounds.
2. The renderer owns one preferred panel width in localStorage, clamped against
   the current viewport, visible sidebar, and MainChat reserve into the effective
   width.
3. Native edge gestures resize the shell only: they may temporarily clamp the
   effective panel width but never overwrite its preference.
4. The divider resizes internal columns only; pointer math is anchored to the
   gesture start, release commits once, and Escape, pointer cancellation, or lost
   capture roll back.
5. Opening, collapsing, session-switching, and closing the panel never change
   native bounds on any platform.
6. The `window/resizeBy` method, resize attribution tickets, panel growth
   tracking, and persisted-width offset are removed.

## Consequences

- Divider feedback stays continuous through release, and a temporarily
  constrained panel returns to its preferred width when space appears.
- Native edge behavior is symmetric, so Windows, macOS, and Linux share one panel
  interaction model.
- The preload surface shrinks; window state is flushed synchronously on close so a
  pending debounce cannot lose the normal bounds.

## Alternatives

- Keep delta IPC with request identifiers: rejects stale replies but keeps the
  circular ownership and the post-release jump.
- Let Electron own the three-column layout: Main does not know renderer sidebar
  state, and layout over IPC would add latency.
