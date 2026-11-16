# ADR 0015: Make settings content responsive to window width

- Status: Accepted
- Date: 2026-07-26

## Context

D070 established a 720px settings content band from a 1200px-wide Codex gold
capture, and D090 retained those visual metrics while simplifying the settings
directory. That fixed cap leaves increasingly large unused space on wider
windows even though the full-page settings shell and right pane already resize
with the native window.

## Decision

The settings content inner container fills 100% of the width available in the
right pane after the 275px rail and pane gutters. CSS flex layout owns resizing;
the renderer does not add window listeners, viewport calculations, or JavaScript
layout state.

This supersedes only D070's 720px content-band cap and the portion of D090 that
retained that cap. All other D070 and D090 navigation, chrome, spacing, card,
theme, and interaction decisions remain unchanged.

## Consequences

- Settings cards expand and contract immediately as the native window resizes.
- Wide windows no longer reserve an arbitrary empty area to the right of the
  content.
- The minimum supported window width continues to preserve the fixed rail and
  existing pane gutters without horizontal page scrolling.
- Settings specs and E2E coverage must verify narrow, default, and wide window
  sizes.

## Alternatives

### Keep the 720px maximum

Rejected because it ignores the available native window width and wastes space
on larger displays.

### Calculate width in React

Rejected because the existing flex layout already exposes the correct available
pane width, while JavaScript window listeners add unnecessary state and
synchronization work.

### Use a viewport-width formula

Rejected because manually subtracting the rail and gutters duplicates CSS layout
knowledge and can drift into overflow.

## References

- `docs/spec/00-baseline.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D092)
