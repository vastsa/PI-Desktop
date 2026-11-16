# ADR 0226: Reserve Chat Width for Composer Controls

- Status: Accepted (amends ADR 0151)
- Date: 2026-09-11
- Related: E2E-168, ADR 0151

## Context

The sidebar and the in-flow work panel both take flex space from MainChat, so a
narrow chat column squeezes the floating composer toolbar's localized chips or wraps
its control groups, and a side dock overlapping an input surface is not an
acceptable fallback.

## Decision

MainPane and its chat surface reserve a fixed minimum width on the chat flex item, so
sidebar and work-panel resize gestures cannot consume or paint over the space the
composer needs. The toolbar stays single-row with `flex-wrap: nowrap` and
non-shrinking control groups, mode and permission labels stay single-line with
chip-local ellipsis, and the work panel remains an in-flow renderer-owned column
requesting no positive native window reservation.

## Consequences

- Sidebar and work-panel resizing preserve a readable control row.
- At a constrained client width the shell may need more horizontal space than the
  native minimum, because the reservation outranks flex compression and overlap.
