# ADR: Device-local project lists in configuration sync

- Status: Accepted
- Date: 2026-10-11

## Context

Project and project-group names, pinning, root lists, and ordering describe a
device's workspace. Synchronizing these records can register unwanted local
workspaces. Project-scoped capabilities still need portable logical bindings
and explicit local folder mappings, without synchronizing the workspace list.
Existing encrypted vaults and local sync state can already contain `projects`
entities and a selected projects category.

## Decision

Remove `projects` from the public `ConfigSyncCategory` contract, category UI,
adapter registry, capture, and application. Normalize saved configuration and
draft categories to the supported category set. Filter retired project entities
from local baselines and pending imports. Validate and authenticate existing
remote revisions completely before ignoring their `projects` entities during
sync or restore.

Keep local project records and remote revision history intact. Do not publish
project deletions to retire the category. Preserve logical identities and local
folder mappings for project-scoped MCP, skills, instructions, memory, and
automation. Receiving devices register their own workspaces when required.
Process ownership, encryption, and approval boundaries remain unchanged.

## Alternatives

- Disable projects by default but retain the category: rejected because it
  still permits workspace-list synchronization.
- Remove all project-scoped configuration: rejected because it unnecessarily
  removes capability synchronization and local mapping support.
- Delete old project entities from cloud history: rejected because immutable
  authenticated revisions remain valid restore points for supported domains.

## Consequences

New clients no longer capture, preview, activate, or restore workspace-list
metadata. Consumers of `ConfigSyncCategory` must stop requesting `projects`.
Previously saved category selections and retired local imports are normalized
without requiring users to disconnect or remove application data. Other
domains in old revisions remain restorable after full validation.

Older clients can still publish project entities into a shared vault; new
clients ignore them. This does not revoke old-client behavior or erase cloud
history. Project-scoped capability imports continue to require explicit folder
mapping and approval, and never synchronize local project names or ordering.

The current behavioral contract is
[Portable configuration sync](../spec/03-runtime/22-config-sync.md); executable
compatibility and multi-device tests prove the implemented boundaries.
