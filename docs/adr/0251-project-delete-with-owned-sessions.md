# ADR 0251: Deleting a Project Removes Its Owned Sessions

- Status: Accepted
- Date: 2026-09-15
- Related: ADR 0016, ADR 0026

## Context

Archive, pin, close, and ordering are renderer-local metadata, and the Projects
index unions durable `projects` rows with recent-project storage, projects derived
from live sessions, and the active workspace, so there was no user-facing way to
remove a durable project row. Deleting only the row would also orphan sessions
through `ON DELETE SET NULL`, and removing a stored group's primary root would
leave the group without a valid primary.

## Decision

1. Host-core gains the additive RPC `projects.remove({ path })`, returning
   `{ removed, sessionsRemoved }`, as the only supported way to remove a durable
   project record.
2. The RPC deletes the project row together with every session whose
   `project_id` points at it, reusing the existing single-session delete path so
   transcript, scratch, and review files go with it, clears the project's durable
   memory, is idempotent for an unknown path, and never touches the folder on disk.
3. A path that is a root of a stored multi-folder project group is refused with a
   structured error, because the user must remove the folder from the group first
   to keep the group's primary root valid; legacy single-root projections delete
   normally.
4. The renderer deletes behind a second confirmation naming the project and its
   session count, and in the same operation drops the archived and pinned
   metadata, the recent-project entry, the retained tab, and the active workspace
   selection, falling back to another open project or Temporary.
5. The action stays renderer-only and is absent from `CONTROL_OPERATION_SPECS`, so
   local MCP control cannot delete projects.
6. A bulk delete is refused while any attached session has a running turn (1008 /
   `CONFLICT`), because that turn still owns its tools and is still appending to
   the transcript the delete would remove; the check and the deletes run in one
   host RPC under the single state lock.

## Consequences

- A durable project row can be removed from the UI without reappearing after
  reload, but its sessions and transcripts are gone permanently and cannot be
  recovered inside the application.
- Group structure is never silently rewritten, so multi-folder users see an
  explicit refusal instead of a corrupted group.
- Listing code must keep all four index sources consistent, and a project with a
  running task must be stopped before deletion.

## Alternatives

- Add a renderer-only hide flag: rejected because it keeps the durable row,
  sessions, and disk usage, which is the reported complaint.
- Abort running turns inside the same call: rejected because the runtime can still
  append afterwards and re-create the session as a stub (D318).
