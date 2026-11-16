# ADR 0110: Version the plugin panel chrome spacing contract

- Status: Accepted
- Date: 2026-08-20
- Related: [ADR 0092](0092-plugin-owned-panel-surface.md) ·
  [ADR 0093](0093-plugin-panel-strict-drag-band.md) ·
  [ADR 0104](0104-plugin-contributed-work-panel-views.md)

## Context

The host-owned plugin capsule reserves a strict drag band, and older plugin pages
relied on preload-added padding while newer pages also read the host titlebar
variable. Host padding then duplicated the safe area and left blank space above
the plugin toolbar.

## Decision

A current plugin page declares `<meta name="pi-plugin-chrome" content="v2">`. The
preload publishes `--pi-plugin-titlebar-height` before layout with the detached
band height or `0px` when docked, and v2 pages own their flow spacing through
that variable while the host adds no extra top padding; pages without the marker
keep the legacy additive offset. The host capsule stays a closed, page-adaptive
three-control capsule in the band, and first-party pages and generated templates
use the v2 marker with the neutral token ramp.

## Consequences

- Detached and docked pages share one deterministic spacing contract.
- Existing third-party pages render unchanged until authors adopt the marker.
- The marker is a small HTML contract, not a manifest schema change.
