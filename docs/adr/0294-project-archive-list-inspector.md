# ADR 0294: Project archive is a list + inspector workbench

- Status: Accepted
- Date: 2026-09-20
- Decision: D455
- Amends: D267 / D168 (row anatomy and inline expansion)
- Related: D133 (archive always visible), D257 (capability workbench),
  [04-ux/06-settings-ia.md](../spec/04-ux/06-settings-ia.md),
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)
  (E2E-038)

## Context

D267 collapsed Project archive to one workbench: a quiet intro, one toolbar,
and one panel whose Pinned / All projects / Archived groups were in-panel
strips. Each row still carried a disclosure control, two lines of metadata,
state tags, a hover action pair, and an inline session list. Adding more
projects made the destination hard to scan: expanding one row pushed the rest
of the index, and clicking a name activated the project and left Settings.

The durable index is a management surface. Selecting a project to inspect it
must not leave the page.

## Decision

1. **Keep the intro and toolbar.** One description line, Recent/Name sort,
   search with a live match count, and Add project. No hero, gradient, or
   page-level counters (D267).
2. **Replace the single expanding list with a list + inspector.** The index
   keeps Pinned / All projects / Archived as labelled regions with per-section
   counts. Compact rows show the color glyph (Star when pinned, Folder
   otherwise), name, one status tag (Active / Open / Archived), session count,
   and relative time. Empty groups are omitted.
3. **Click selects; activation is explicit.** A click (or ArrowUp/ArrowDown)
   selects the row and keeps Settings open. Double-click, Enter, or the
   inspector Open action activates the project and returns to chat. Archive and
   close still keep Project archive open.
4. **The inspector owns management, in one column.** Folders, chats (latest
   first, batches of eight), New task, and the existing menu (instructions,
   memory, edit, pin, archive/restore, two-step delete, close) open under the
   selected row at full content width. There is no side-by-side pane. Archived
   records stay grouped and visible; there is still no visibility toggle (D133).
5. **Search still matches session titles.** A session-title hit keeps the
   owning project in the index, selects it, and lists the matching chats in
   the inspector.
6. **Presentation only.** No IPC, storage, host protocol, or activation
   semantics change beyond the click-vs-activate split on this destination.

## Consequences

- Compact rows stay scannable; only the selected project opens its full-width detail.
- A single click no longer leaves Settings, which is the management path; the
  chat path is Open / double-click / Enter / opening a session.
- Source-contract tests for the archive destination now cover the workbench
  and the extracted `project-archive` helpers.

## Alternatives

- Keep inline expansion and add a density toggle. Rejected: the row still
  dumps every action onto the index.
- Hide archived records behind a filter. Rejected: D133 forbids a visibility
  toggle on this destination.
