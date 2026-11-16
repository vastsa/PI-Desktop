# ADR: Remote projects in the shared Chat home workflow

- Status: Superseded for new projects by [Local Agent remote workspace tools](local-agent-remote-workspace-tools.md)
- Date: 2026-10-11
- Related: ADR 0286, ADR 0292,
  [remote Agent Control](../spec/02-architecture/05-remote-agent-control.md)

## Context

The experimental remote client already registers Host directories and routes
session operations over RACP. Its project creation entry point lived in
Settings, and opening a remote chat replaced the regular chat surface with a
separate text-only conversation UI.

## Decision

Use the existing Create project dialog and shared ChatSurface, Composer, and
retained transcript panes for remote projects. The dialog selects a connected
Host, an existing remote project, or a directory on that Host.

Electron main validates the host/path input and directory response. The Host
retains its canonical directory containment and browse-root policy.

## Alternatives

- Add another home shortcut to the Settings workbench: simpler, but leaves
  different creation, project switching, and conversation workflows.
- Treat remote paths as local project paths: rejected because identity
  collisions and workspace activation would cross the machine and security
  boundary.
- Enable all local controls for remote chats: rejected because the current Host
  capability profile does not implement those operations or desktop-tool relay.

## Consequences

No persisted database, Plugin SDK, Host wire protocol, provider ownership, or
process architecture changes.

Validation covers real dialog/Composer/project-switching interactions with
isolated IPC fixtures, retained-pane action guards, opaque history cursors, and
a packaged Host directory-selection-to-agent-turn path with a local model
fixture.
