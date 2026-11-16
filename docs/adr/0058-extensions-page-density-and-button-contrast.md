# ADR 0058: Extensions Page Density and Theme-Readable Button Surfaces

- Status: Accepted (IA amended by ADR 0112)
- Date: 2026-08-05
- Related: D196, ADR 0112

## Context

The Extensions destination is a two-tab plugin surface (Installed, Marketplace)
whose four-counter overview band repeated state the tabs, groups, and update
alerts already showed, and the shared button primitive leaned on gray-scale
aliases and transparent fills that left secondary actions weak in dark mode.

## Decision

Remove the overview band and its four derived counters, keeping the two tabs with
counts, installed state groups, and pending-update alerts as the hierarchy. Define
primary and secondary buttons on semantic tokens — `--ds-accent` over
`--ds-bg-primary`, `--ds-bg-secondary` with `--ds-text-primary` and
`--ds-border-default`, hover on `--ds-accent-hover` and `--ds-bg-tertiary`. This
is a renderer presentation change only: no plugin, MCP, skill, marketplace,
permission, host, protocol, or storage contract changes.

## Consequences

- The header and segmented control reach content sooner, with counts next to the
  surface they describe.
- Actions gain an opaque theme-correct surface and a visible semantic edge in
  both themes.

## Alternatives

- Keep the band narrowed to two cards: still duplicates state.
- Hard-code per-theme colors: bypasses the semantic token contract.
