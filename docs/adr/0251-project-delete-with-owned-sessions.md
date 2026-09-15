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

That left no user-facing way to remove a durable project record. A user who
archived a project that should no longer exist could only edit host-core's
SQLite file directly and clear renderer storage afterwards, because the Projects
index is a union of four sources: project-group projections of the durable
`projects` rows, `pi.desktop.recentProjects`, projects re-derived from live
sessions, and the active workspace. Deleting only the database row leaves the
other three sources in place, so the row reappears.

Two integrity facts constrain the fix:

- `PRAGMA foreign_keys = ON` is enforced. `sessions.project_id` and
  `scheduled_tasks.project_id` are `ON DELETE SET NULL`, so deleting a project
  row alone orphans its sessions rather than removing them.
- A stored (non-legacy) project group owns an ordered root list and a primary
  root. Removing the primary root underneath the group would leave the group
  without a valid primary.

## Decision

1. Host-core gains the additive RPC `projects.remove({ path })`, returning
   `{ removed, sessionsRemoved }`. It is the only supported way to remove a
   durable project record.
2. The RPC deletes the project row together with every session whose
   `project_id` points at it, reusing the existing `sessions::delete_session`
   path so transcript, scratch, and review files are removed exactly as they are
   for a single conversation delete, and it clears the project's durable memory.
   It is idempotent for an unknown path, and it is refused while any attached
   session has a running turn (see 7).
3. The RPC never touches the project's folder on disk. PI-Desktop deletes
   application records, never user files, and a project whose folder was moved
   or deleted is still removable.
4. A path that is a root of a stored multi-folder project group is refused with
   a structured error. The user removes the folder from the group first, which
   keeps the group's primary root valid; legacy single-root projections are not
   affected and delete normally.
5. Deleting is a renderer action behind a second confirmation that names the
   project and the number of sessions it owns. On success the renderer drops the
   matching renderer-local record in the same operation: the archived/pinned
   metadata, the recent-project entry, the retained tab, and, when the deleted
   project was active, the workspace falls back to another open project or to
   Temporary. A path the host has no durable row for is not a failure: the
   renderer-local record is removed anyway, because a stale recent-project entry
   is the only thing that can keep such a row visible.
6. The action stays renderer-only. It is deliberately absent from
   `CONTROL_OPERATION_SPECS`, so local MCP control cannot delete projects.
7. The bulk delete is refused while any attached session has a running turn
   (1008 / `CONFLICT`). A live turn still owns its tools and working directory
   and is still appending to the transcript the delete would remove, so the
   operation is deliberately stricter than single-conversation delete, which
   keeps its current semantics. The renderer blocks the same action up front, so
   users normally meet a message instead of an error, and a refusal that
   reaches the dialog is shown with the same localized copy. The check and the
   deletes run in one host RPC under the host's single state lock, so no turn
   can start between them.

## Consequences

- A durable project row can finally be removed from the UI, and the row no
  longer reappears after a reload, because the durable row and the renderer-local
  records are removed by one action.
- Sessions and transcripts of a deleted project are gone permanently. A project
  delete is therefore not recoverable from the application; the folder on disk
  and any file-level history outside PI-Desktop are unaffected.
- Group structure is never silently rewritten. Users with multi-folder projects
  see an explicit refusal instead of a corrupted group.
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
- **Detach the root from a multi-folder group inside the same call.** Rejected
  for now: `project.group.update` refuses to detach a root that has chats, and
  silently rewriting group structure during a delete makes the outcome hard to
  predict. The refusal path can be relaxed by a later ADR.
- **Abort the running turns inside the same call.** Rejected: host-core can
  settle a turn's own bookkeeping but cannot stop the agent runtime that is
  still streaming into that session, so an aborted-then-deleted session can
  still be re-created as a stub by the next append (D318). Refusing the delete
  keeps the timing decision with the user and leaves no window for that.
