# ADR 0065: Smooth shell layout and stream feedback

- Status: Accepted for implementation
- Date: 2026-08-07
- Related: ADR 0033, ADR 0122, D146, D163, D255

## Context

Sidebar and work-panel keyframes changed only opacity and a small transform
while the flex allocation jumped to its final width on mount, so MainChat moved
before the first visible frame. Agent streams also applied every
`message_update` and `tool_update` immediately, spending frames on historical
transcript work, and the docked composer painted a full-width gradient veil that
carried no state.

## Decision

1. Sidebar and work-panel mount/exit animations animate `width` and `flex-basis`
   from zero to the committed dock width alongside the opacity/transform
   feedback, keeping the panel an in-flow fixed-width column.
2. The renderer coalesces high-frequency `message_update` and `tool_update`
   events per stream target until the next animation frame, applying only the
   newest event; any control or terminal event flushes the batch first.
3. `ChatTranscript` defers the heavy grouped-entry projection through React's
   deferred value while permission, running, and terminal state stay
   synchronous.
4. The docked composer keeps a transparent outer dock with space reserved by
   the transcript, so the composer shell remains the only elevated surface.
5. A group takes terminal failure styling only after its active run settles, so
   an intermediate error row does not make a retrying run look finished.

## Consequences

- Auxiliary columns reflow MainChat continuously instead of jumping first.
- Newest partial content can appear one paint later, but redundant payloads are
  dropped and terminal events are never delayed.
- Long transcripts still need real virtualization; this reduces update pressure
  without changing persistence or grouping.

## Alternatives considered

- Transform-only dock animation: rejected; the flex allocation still jumps
  before the first painted frame.
- Debounce all agent events: rejected; lifecycle, permission, and terminal
  events need immediate ordering.
