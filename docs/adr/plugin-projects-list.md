# ADR: Read-only durable project enumeration for plugins

- Status: Accepted
- Date: 2026-10-30
- Related: [Issue 1996](https://github.com/vastsa/PI-Desktop/issues/1996),
  [ADR 0201](0201-plugin-project-ids-and-session-refresh.md),
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md)

## Context

Plugins can observe the visible workspace but cannot enumerate durable projects.
A project picker therefore depends on the selected session, and group identities
cannot identify standalone database rows consistently. The Host already owns
both the project index and logical group metadata.

## Decision

Add `pi.projects.list()` and the equivalent panel bridge channel. Electron main
projects the existing Host `projects.list` response into metadata, enriching a
row from the group whose primary path matches it. There remains one entry per
database row; secondary-folder rows retain their own path and identity. Sort by
last-opened time rather than inheriting the archive's pinned-first order.

Use the decimal string form of `projects.id`, without a prefix, as `projectId`.
It matches the numeric identity returned by `pi.project.create` and stays stable
for a row's lifetime. Existing `workspace.get().projectId` continues to mean a
logical group id. Deletion and recreation may produce a new identity; there is
no migration of plugin-owned path keys in this host API change.

The new API exposes only ids, names and registered paths, so it needs no new
permission. It does not change the workspace, session bindings, filesystem
scope, or the project creation/import permission gates. Missing group metadata
reduces a row to its own primary root. Missing or failed project lookup returns
an empty list and emits a diagnostic; results from a replaced Host are discarded.

## Alternatives

Extending `workspace.get` would conflate selection with enumeration. Returning
groups alone would omit distinct durable rows and substitute a different id
namespace. Deriving identity from a path would change on rename and repeat the
plugin-specific identity schemes this API is intended to remove.

## Consequences

Plugins can build project pickers while the current session has no project.
The addition is backward compatible and needs no database migration or Host
protocol change. Metadata discovery never authorizes reading those paths.
