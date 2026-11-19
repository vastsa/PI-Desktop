# ADR 0016: Organize the sidebar around retained multi-project tabs

- Status: Accepted
- Date: 2026-07-26

## Context

D088 replaced the mixed Recents list with one current-project group plus
path-less Temporary sessions, which made the workspace boundary visible but
forced every project switch to replace the only group and removed basic
organization controls. Users working across repositories need several projects
retained at once, collapsible inactive groups, and pin/archive on project and
conversation rows without deleting durable data. The host still exposes exactly
one selected workspace, and enlarging that to a multi-workspace registry would
make background tool execution depend on whichever tab was selected last.

## Decision

### Retained project tabs

The renderer keeps an ordered set of normalized project paths, each rendered as
an independently collapsible sidebar group alongside a separate path-less
Temporary group. Opening a project adds a tab without closing others and
activating one calls the existing `project.set`; closing a tab drops only the
sidebar entry and never archives projects or sessions.

### Renderer-owned organization metadata

Project metadata is keyed by normalized full path (`pinned`, `archived`,
`collapsed`, optional manual `order`) and conversation metadata by durable
session id (`pinned`, `archived`, optional `order`), stored as best-effort
renderer local storage with no privileged data. Sort supports `recent`,
`created`, `oldest`, and `name`, with pinned rows first and archive
non-destructive and recoverable through the archived view.

### Session workspace isolation

The project persisted on the session is the authority for that session's tool
root: `tools.execute` resolves the workspace from `session.projectPath` /
`project_id`, not from the mutable active tab, so switching projects or
conversations never aborts a running turn and Temporary sessions inherit no
project access.

This supersedes D088's one-current-project and no-multi-project-tree
limitations and restores the scoped project/conversation row actions superseded
with D068; D088's exact-path grouping, scoped draft reuse, and Temporary session
boundary remain in force. No new renderer IPC channel is required.

## Consequences

- Inactive projects, pin, archive, collapse, and sort survive app restart when
  renderer preferences are available; clearing them resets presentation only.
- Tool execution must load the session before resolving its workspace.
- Host-owned projects and sessions stay authoritative, with the Projects index
  still the recovery path for closed or archived tabs.

## Alternatives

- Store pin and archive flags in the host schema: rejected because they affect
  only local presentation.
- Open each project in a separate native window: rejected because it multiplies
  window and process state without solving conversation organization.
