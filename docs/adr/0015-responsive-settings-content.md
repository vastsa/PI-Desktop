# ADR 0015: Make settings content responsive to window width

- Status: Accepted
- Date: 2026-07-26

## Context

D070 fixed the settings content band at 720px from a Codex capture and D090 kept
that metric while simplifying the directory. The fixed cap wastes space on wider
windows, although the settings shell and right pane already resize natively.

## Decision

The settings content inner container fills 100% of the width left in the right pane
after the fixed navigation rail and pane gutters. CSS flex layout owns the resizing;
the renderer adds no window listeners, viewport math, or JavaScript layout state.

This supersedes only D070's 720px cap and the part of D090 that retained it (D092);
every other D070 and D090 navigation, chrome, spacing, card, theme, and interaction
decision stands.

## Consequences

- Cards follow the native window immediately, so wide windows reserve no empty area
  beside the content.
- The minimum supported window width still fits the rail and gutters without
  horizontal scrolling.

## Alternatives

- Keep the 720px maximum: it ignores the available width.
- Measure in React: flex layout already exposes the pane width while listeners add
  state to synchronize.
- Use a viewport-width formula: it duplicates CSS layout knowledge and drifts into
  overflow.
