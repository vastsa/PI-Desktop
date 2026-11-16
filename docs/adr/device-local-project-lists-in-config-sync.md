# ADR: Device-local project lists in configuration sync

- Status: Accepted
- Date: 2026-10-11

## Context

Project and project-group names, pinning, root lists, and ordering describe a
device's workspace, so synchronizing them can register unwanted local workspaces,
while project-scoped capabilities still need portable logical bindings and explicit
local folder mappings without synchronizing the workspace list.

## Decision

Remove `projects` from the public `ConfigSyncCategory` contract, category UI, adapter
registry, capture, and application, normalize saved configuration and draft
categories to the supported set, filter retired project entities from local baselines
and pending imports, and validate and authenticate existing remote revisions
completely before ignoring their `projects` entities during sync or restore. Local
project records and remote revision history stay intact, project deletions are not
published, and logical identities and local folder mappings are preserved for
project-scoped MCP, skills, instructions, memory, and automation.

## Consequences

- New clients no longer capture, preview, activate, or restore workspace-list
  metadata, and consumers of `ConfigSyncCategory` stop requesting `projects`.
- Saved category selections and retired local imports are normalized without user
  action, and other domains in old revisions remain restorable after full validation.
- Older clients can still publish project entities that new clients ignore, which
  neither revokes their behavior nor erases cloud history.

## Alternatives

- Disable projects by default but keep the category: still permits workspace-list
  synchronization.
- Delete old project entities from cloud history: immutable revisions remain valid
  restore points.
