# ADR: Remote projects in the shared Chat home workflow

- Status: Superseded for new projects by [Local Agent remote workspace tools](local-agent-remote-workspace-tools.md)
- Date: 2026-10-11
- Related: ADR 0286, ADR 0292,
  [remote Agent Control](../spec/02-architecture/05-remote-agent-control.md)

## Context

The experimental remote client already registers Host directories and routes
session operations over RACP. Its project creation entry point lived in Settings,
and opening a remote chat replaced the regular chat surface with a separate
text-only conversation UI. Users could not create a remote project from home or
switch between local and remote projects through the usual project controls.

Remote paths cannot be reused as local workspace paths. The two machines can
have identical directory names, and a retained remote transcript must never
authorize a file/plugin operation against the currently visible local workspace.

## Decision

Use the existing Create project dialog and shared ChatSurface, Composer, and
retained transcript panes for remote projects. The dialog selects a connected
Host, an existing remote project, or a directory on that Host. An additive
Desktop-only `remoteHostBrowseProjects` IPC channel exposes the Host's existing
`project/browse` operation; it does not add a RACP method or protocol version.

Electron main validates the host/path input and directory response. The Host
retains its canonical directory containment and browse-root policy. Default and
explicit browse paths both canonicalize before containment checks so a browse
root reached through a directory symlink has the same behavior as its real path.

Identify a remote project with the pair `(hostKey, projectId)`. Home and sidebar
selection call remote session creation directly; they never place a remote path
in local project state or activate a local workspace. New chat reuses only an
empty, idle, unsubmitted chat within that identity. An in-flight creation cannot
take focus after a newer navigation intent, and duplicate requests share a promise.
Successful creation remains discoverable even if the user has navigated away.

Use session capabilities at Composer and transcript action boundaries. Remote
text, tools, permissions, and input cards use the shared rendering path, while
local attachment staging, commands, plugins, file/image resolution, previews,
rollback, and unsupported configuration or subagent actions remain unavailable.
Retained panes authorize against their own session rather than the visible one.
History forwards the Host's session-owned cursors without offset arithmetic.

## Alternatives

- Add another home shortcut to the Settings workbench: simpler, but leaves
  different creation, project switching, and conversation workflows.
- Treat remote paths as local project paths: rejected because identity collisions
  and workspace activation would cross the machine and security boundary.
- Enable all local controls for remote chats: rejected because the current Host
  capability profile does not implement those operations or desktop-tool relay.

## Consequences

No persisted database, Plugin SDK, Host wire protocol, provider ownership, or
process architecture changes. Local projects and concurrent local work remain
unchanged. Remote project labels still come from Host directory names, and
unsupported features remain disabled; this is not full R2 feature acceptance.

Validation covers real dialog/Composer/project-switching interactions with
isolated IPC fixtures, retained-pane action guards, opaque history cursors, and
a packaged Host directory-selection-to-agent-turn path with a local model fixture.
Real SSH bootstrap and release acceptance remain separate scenarios.
