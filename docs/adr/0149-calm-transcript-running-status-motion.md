# ADR 0149: Calm transcript running-status motion

- Status: Accepted
- Date: 2026-09-04
- Deciders: PI-Desktop core
- Related: D071, D290, E2E-053, E2E-083

## Context

The transcript used a fast gradient shimmer clipped into the text of the
pre-stream Working indicator and active thinking/tool labels. Because the
foreground highlight moved through each glyph, the status copy changed
contrast continuously and was harder to scan during a long run. The existing
tool spinner and streaming rail already provide motion for the concrete live
states.

## Decision

Running transcript copy remains a static, readable semantic text color. The
pre-stream Working indicator adds a compact three-dot marker with a staggered
one-second opacity/scale pulse. Active thinking and tool labels use one small
status marker with a one-second opacity pulse instead of a text shimmer. Tool
spinners, run-row status dots, and the assistant streaming rail keep their
existing state feedback.

All new marker motion is disabled under `prefers-reduced-motion: reduce`; the
text and static marker remain visible so state is never conveyed by motion
alone. No protocol, persistence, runtime, or localization contract changes.

## Consequences

- Working and active tool labels stay legible at every animation frame.
- The transcript has one restrained loading language: readable copy plus a
  small status marker, without a moving highlight over text.
- Tests and rendered review should verify both light/dark themes and reduced
  motion, especially while a turn has not produced its first event.

## Alternatives rejected

- Keep the text shimmer and slow it down: slower contrast changes still make
  the label itself unstable and provide little additional state information.
- Replace the status with a large card or progress timeline: this would add
  decorative surface and density to a transient state that needs only a wait
  signal.
