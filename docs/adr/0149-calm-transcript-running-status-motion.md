# ADR 0149: Calm transcript running-status motion

- Status: Accepted
- Date: 2026-09-04
- Amended: 2026-10-21
- Related: D071, D290

## Context

The transcript clipped a fast gradient shimmer into the text of the pre-stream
Working indicator and active thinking/tool labels, so the status copy changed
contrast continuously and was hard to scan during a long run. The tool spinner
and streaming rail already supply motion for the concrete live states.

## Decision

Running transcript copy keeps a static, readable semantic text color. The
pre-stream Working indicator adds a compact three-dot marker with a staggered
one-second opacity and scale pulse, active thinking and tool labels use one small
status marker with a one-second opacity pulse, and tool spinners, run-row status
dots, and the assistant streaming rail keep their existing feedback.

The Thinking indicator is the explicit exception: the collapsed live label uses
a whole-run `TextShimmer` with a 1.2s sweep and 220ms fade, defined by
`turn-process-and-thinking-display` (2026-10-21), never moving the highlight
glyph by glyph. All motion is disabled under `prefers-reduced-motion: reduce`
while the text and static marker stay visible, so state is never conveyed by
motion alone.

## Consequences

- Working and active tool labels stay legible at every animation frame.
- The transcript has one restrained loading language, without a moving highlight
  over text.
- No protocol, persistence, runtime, or localization contract changes.

## Alternatives rejected

- Keep the shimmer and slow it down: the label itself stays unstable and gains
  little state information.
- Replace the status with a large card or progress timeline: it adds decorative
  density to a transient wait signal.
