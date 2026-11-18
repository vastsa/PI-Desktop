# ADR 0032: Reserve native width for the docked work panel

- Status: Accepted (amended by ADR 0033 and ADR 0122)
- Date: 2026-07-29
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D163
- Supersedes in part: ADR 0029 and decision D156

## Context

ADR 0029 removed a circular ownership model in which work-panel changes and
native resize events rewrote each other, leaving the panel a responsive column
inside the client area: no races, but opening the panel consumed chat width,
collapsing it expanded chat again, and a native edge resize could compress the
panel.

The intended docked behavior is closer to Codex: the panel has a committed width
of its own, the window reserves native width for it while visible, and native
edges resize the conversation rather than the tool surface.

## Decision

Renderer panel layout and Electron window geometry stay separate owners that
coordinate through an idempotent target-state reservation:

1. The renderer owns one committed preferred panel width in the inclusive
   `364..720` range; an open panel renders at that width, and viewport, sidebar,
   and native-edge changes never clamp or rewrite it.
2. The preload exposes only
   `window/setWorkPanelReservation({ width: 0 | 364..720 })`, and Main returns
   `{ requested, reserved }` — the normalized target and the native width added
   for it — so repeating a target has no cumulative effect.
3. In normal window state Main derives visible bounds from persisted base bounds
   plus the target reservation, expanding right first and shifting left only as
   far as the display work area requires, with `reserved` capped by available
   work-area width.
4. Opening requests the committed width; collapsing or closing the final
   resource requests zero and symmetrically removes the added width and any
   x shift. A committed divider change retargets the reservation, and only the
   visible session context may set it.
5. When the work area can supply the full target, visibility and divider commits
   do not change chat width; otherwise the panel keeps its committed width and
   chat absorbs the unavoidable `requested - reserved` shortfall.
6. Native edge resizing changes base bounds and therefore chat width only, while
   maximized and fullscreen windows record the target and reconcile it on return
   to normal state or on a display or work-area change.
7. Persisted normal bounds exclude reservation width and x shift, so relaunch
   never restores a panel-expanded shell.

ADR 0029's anchored pointer math, frame-coalesced preview, commit-on-release, and
cancellation rollback stay in force; only a successful commit changes the native
target.

## Consequences

- Opening and collapsing preserve conversation width whenever the work area has
  unused width, and native edge gestures resize only the conversation.
- Small displays can narrow chat below its 360px readability target, but never
  compress the panel or corrupt its committed preference.
- Main holds a narrow allowlisted geometry capability rather than an arbitrary
  delta channel, and window-state persistence must keep base bounds distinct
  from temporary reservation geometry.

## Alternatives

- Keep all columns inside the client area: rejected, open/collapse would keep
  resizing the conversation and edge gestures could compress the panel.
- Restore renderer-supplied resize deltas: rejected, deltas are not idempotent
  and recreate the stale-request and double-resize races ADR 0029 removed.
- Force the full reservation outside the work area: rejected, a fixed panel must
  not push native chrome off screen.
