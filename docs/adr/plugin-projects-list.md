# ADR: Read-only durable project enumeration for plugins

- Status: Accepted
- Date: 2026-10-30
- Related: [Issue 1996](https://github.com/vastsa/PI-Desktop/issues/1996),
  [ADR 0201](0201-plugin-project-ids-and-session-refresh.md),
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md)

## Context

Plugins can observe the visible workspace but cannot enumerate durable projects.
A project picker therefore depends on the selected session, and group identities
cannot identify standalone database rows consistently.

## Decision

Add `pi.projects.list()` and the equivalent panel bridge channel. Electron main
projects the existing Host `projects.list` response into metadata, enriching a
row from the group whose primary path matches it.

Use the decimal string form of `projects.id`, without a prefix, as `projectId`.
It matches the numeric identity returned by `pi.project.create` and stays stable
for a row's lifetime.

## Alternatives

Extending `workspace.get` would conflate selection with enumeration.

## Consequences

Plugins can build project pickers while the current session has no project.
