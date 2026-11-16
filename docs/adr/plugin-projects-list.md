# ADR: Read-only durable project enumeration for plugins

- Status: Accepted
- Date: 2026-10-30
- Related: [Issue 1996](https://github.com/vastsa/PI-Desktop/issues/1996),
  [ADR 0201](0201-plugin-project-ids-and-session-refresh.md),
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md)

## Context

Plugins can observe the visible workspace but cannot enumerate durable projects, so
a project picker depends on the selected session and group identities cannot
identify standalone database rows, although the Host owns both the project index
and the logical group metadata.

## Decision

Add `pi.projects.list()` and the equivalent panel bridge channel. Electron main
projects the Host `projects.list` response into metadata, enriching a row from the
group whose primary path matches it, with one entry per database row and
secondary rows keeping their own path and identity.

`projectId` is the decimal string form of `projects.id` without a prefix: it matches
the identity `pi.project.create` returns and is stable for the row's lifetime, while
`workspace.get().projectId` still means a logical group id. The API exposes only
ids, names, and registered paths, so it needs no new permission and changes no
workspace, binding, filesystem scope, or creation gate.

## Consequences

Plugins can build project pickers with no selected project; the addition is backward
compatible, needs no migration, and never authorizes reading those paths.

## Alternatives

- Extending `workspace.get`: conflates selection with enumeration.
- Returning groups alone, or deriving identity from a path: the first omits distinct
  rows and the second changes on rename.
