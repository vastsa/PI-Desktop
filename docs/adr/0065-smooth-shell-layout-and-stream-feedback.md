# ADR 0065: Smooth shell layout and stream feedback

- Status: Accepted for implementation
- Date: 2026-08-07
- Deciders: PI-Desktop core
- Related: ADR 0033, ADR 0122, D146, D163, D255

## Context

The shell's sidebar and work panel already used enter/exit keyframes, but the
keyframes changed only opacity and a small transform. Their flex allocations
changed to the final width as soon as the element mounted, so MainChat moved
before the first visible frame and moved back after the exit animation.

## Decision

1. Sidebar and work-panel mount/exit animations animate both `width` and
   `flex-basis` from zero to the committed dock width, in addition to the
   bounded opacity/transform feedback.
2. The renderer coalesces high-frequency `message_update` and `tool_update`
   events by stream target until the next animation frame.
3. `ChatTranscript` uses React's deferred value for the heavy grouped-entry
   projection and minimap input.
4. The docked composer uses a transparent outer dock with bottom space reserved
   by the transcript; the composer shell remains the only elevated surface.
5. An activity group only receives terminal failure styling after its active run
   settles.

## Consequences

- Opening and closing auxiliary columns now reflows MainChat continuously over
  the bounded motion duration instead of jumping before the animation.
- A stream may display the newest partial content one paint later when events
  arrive faster than the display refreshes, but redundant intermediate payloads
  are discarded and terminal events are never delayed.
- Long transcripts still need a future true virtualization pass; this decision
  reduces update pressure without changing message persistence or grouping.
- Removing the dock veil makes the transcript surface visually quieter and keeps
  the composer separation dependent on its measured layout and elevation.

## Alternatives considered

### Transform-only dock animation

Rejected because it leaves the flex allocation at its final value before the
first painted frame, which is the source of the visible layout jump.

### Overlay the work panel above MainChat

Rejected for this change because the current frozen shell contract is a docked
third column with a fixed committed width.

### Debounce all agent events

Rejected because lifecycle, permission, planning, and terminal events need
immediate ordering.
