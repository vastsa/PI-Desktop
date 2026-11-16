# ADR: Remote projects in the shared Chat home workflow

- Status: Superseded for new projects by [Local Agent remote workspace tools](local-agent-remote-workspace-tools.md)
- Date: 2026-10-11
- Related: ADR 0286, ADR 0292, [remote Agent Control](../spec/02-architecture/05-remote-agent-control.md)

## Context

The remote client registered Host directories and routed session operations over
RACP, but project creation lived in Settings and opening a remote chat replaced
the chat surface with a separate text-only UI, so users could neither create a
remote project from home nor switch projects through the usual controls. Remote
paths must also never be reused as local workspace paths.

## Decision

Remote projects use the existing Create project dialog and the shared
ChatSurface, Composer, and transcript panes, with an additive Desktop-only
`remoteHostBrowseProjects` IPC channel exposing the Host's `project/browse`
operation and no new RACP method or protocol version. Electron main validates
host and path input, and the Host keeps its canonical containment and
browse-root policy. A remote project is identified by `(hostKey, projectId)`:
home and sidebar selection create remote sessions directly and never place a
remote path in local project state, new chat reuses only an empty idle chat in
that identity, and retained panes authorize against their own session. Composer
and transcript actions follow session capabilities, so text, tools, permissions,
and input cards work while local attachment staging, commands, plugins, file
resolution, previews, rollback, and unsupported configuration stay unavailable.

## Consequences

- No persisted database, Plugin SDK, Host wire protocol, or process architecture
  change, and local projects and concurrent local work are unaffected.
- Remote chats keep unsupported features disabled; this is not full R2 feature
  acceptance.

## Alternatives

- Treat remote paths as local project paths: rejected, identity collisions would
  cross the machine and security boundary.
- Enable all local controls for remote chats: rejected, the Host capability
  profile does not implement them.
