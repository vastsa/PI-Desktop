# ADR: Device-local project lists in configuration sync

- Status: Accepted
- Date: 2026-10-11

## Context

Project and project-group names, pinning, root lists, and ordering describe a
device's workspace. Synchronizing these records can register unwanted local
workspaces.

## Decision

Remove `projects` from the public `ConfigSyncCategory` contract, category UI,
adapter registry, capture, and application. Normalize saved configuration and
draft categories to the supported category set.

Keep local project records and remote revision history intact. Do not publish
project deletions to retire the category.

## Alternatives

- Disable projects by default but retain the category: rejected because it still
  permits workspace-list synchronization.
- Remove all project-scoped configuration: rejected because it unnecessarily
  removes capability synchronization and local mapping support.
- Delete old project entities from cloud history: rejected because immutable
  authenticated revisions remain valid restore points for supported domains.

## Consequences

New clients no longer capture, preview, activate, or restore workspace-list
metadata.

Older clients can still publish project entities into a shared vault; new
clients ignore them.
