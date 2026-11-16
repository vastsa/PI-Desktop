# ADR 0294: Project archive is a list + inspector workbench

- Status: Accepted
- Date: 2026-09-20
- Related: D133, D257, D455, E2E-038
- Amends: D267 / D168 (row anatomy and inline expansion)

## Context

D267 collapsed Project archive into one workbench with in-panel Pinned, All
projects, and Archived groups, but each row still carried a disclosure control,
two metadata lines, tags, a hover action pair, and an inline session list. Adding
projects made the destination hard to scan, expanding a row pushed the rest of the
index, and clicking a name activated the project and left Settings.

## Decision

The intro and toolbar stay: one description line, Recent or Name sort, search with
a live match count, and Add project, with no hero or page-level counters (D267).
The expanding list becomes a list plus inspector: Pinned, All projects, and
Archived stay labelled regions with per-section counts, and compact rows show the
color glyph, name, one status tag, session count, and relative time. A click or
ArrowUp/ArrowDown selects a row and keeps Settings open, while double-click, Enter,
or the inspector Open action activates the project and returns to chat. The
inspector owns management in one column under the selected row at full content
width — folders, chats, New task, and the existing menu — with no side-by-side pane
and no visibility toggle (D133). Search still matches session titles. Everything is
renderer-local: no IPC, storage, or protocol change, and explicitly activating an
archived project clears its presentation state while mere selection does not.

## Consequences

- Compact rows stay scannable and only the selected project opens its full-width
  detail.
- A single click no longer leaves Settings, so the chat path is Open,
  double-click, Enter, or opening one of its sessions.
- Source-contract tests now cover the workbench and the extracted
  `project-archive` helpers.
