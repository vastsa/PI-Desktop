# ADR 0251: Deleting a Project Removes Its Owned Sessions

- Status: Accepted
- Date: 2026-09-15
- Deciders: PI-Desktop maintainers

## Context

The Projects index has listed durable project records since ADR 0026 moved it
into Settings, and ADR 0016 made the sidebar a retained-tab surface. Archive,
pin, close, and ordering are deliberately renderer-local metadata: the component
contract states that "Project close removes retained tab only; durable
project/sessions remain", and `US-UI-47` states that renderer metadata never
hides or deletes a durable Project-archive row.

- `PRAGMA foreign_keys = ON` is enforced.
- A stored (non-legacy) project group owns an ordered root list and a primary
  root.

## Decision

1. Host-core gains the additive RPC `projects.remove({ path })`, returning `{
   removed, sessionsRemoved }`.
2. The RPC deletes the project row together with every session whose
   `project_id` points at it, reusing the existing `sessions::delete_session`
   path so transcript, scratch, and review files are removed exactly as they are
   for a single conversation delete, and it clears the project's durable memory.
3. The RPC never touches the project's folder on disk.
4. A path that is a root of a stored multi-folder project group is refused with
   a structured error.
5. Deleting is a renderer action behind a second confirmation that names the
   project and the number of sessions it owns.
6. The action stays renderer-only.
7. The bulk delete is refused while any attached session has a running turn
   (1008 / `CONFLICT`).

## Consequences

- A durable project row can finally be removed from the UI, and the row no
  longer reappears after a reload, because the durable row and the
  renderer-local records are removed by one action.
- Sessions and transcripts of a deleted project are gone permanently.
- Group structure is never silently rewritten.
- Composer/sidebar code that lists projects must treat the four index sources
  consistently; a future index source has to be cleaned by the same action, or
  the row will reappear.
- A project with a running task must be stopped before it can be deleted, which
  is one extra step in that case; the alternative was deleting under a live
  writer, which can resurrect a session row for the transcript the user just
  removed.

## Alternatives

- **Add a renderer-only "hide" flag.** Rejected: it keeps the durable row, the
  sessions, and the disk usage, which is the complaint that motivated the
  change, and it contradicts `US-UI-47`'s promise about renderer metadata.
- **Delete the project row and let `ON DELETE SET NULL` orphan the sessions.**
  Rejected: it produces unreachable conversations that still occupy the
  transcript directory and still look like a project in the index.
- **Delete the project's folder on disk too.** Rejected: an application action
  must not remove user files.
- **Detach the root from a multi-folder group inside the same call.** Rejected:
  root membership changes remain an explicit Edit project action, separate from
  the destructive project-delete confirmation.
