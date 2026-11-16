# ADR 0150: Inline SVG empty-home agent mark

- Status: Superseded by ADR 0152
- Date: 2026-09-04
- Related: D291

## Context

The empty-home hero used a randomized raster sprite atlas whose discrete frames
and hover-accelerated playback read as loud in the conversation area.

## Decision

Replace the atlas with a decorative inline SVG agent mark in the existing 100px
slot: a slowly rotating orbit and signal point, a breathing core, and occasional
blinks, all deterministic and frozen under `prefers-reduced-motion: reduce`.

## Consequences

Superseded by ADR 0152, which made eight-frame GIF artwork the empty-home mark.
The component kept no atlas, random selection, timer, or hover state.
