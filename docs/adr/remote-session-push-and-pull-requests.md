# ADR: Push, pull requests, and cleanup for repository sessions

- Status: Accepted
- Date: 2026-11-20
- Related: D690, [Environments and composer session targets](environments-and-session-targets.md)

## Context

A repository session has its own branch on a paired Host. Users need to publish
commits, open a pull request, and remove the checkout without losing work by
surprise.

## Decision

Electron main drives the Host's push job and searches GitHub for an open pull
request for the work branch before it creates one. A successful request is
recorded on the workspace binding. Publishing sends existing commits. Concurrent
actions in the same session join the same operation. Clicking the pull request
action checks GitHub for an open request. If none is open, Desktop clears the
old binding and offers to create a replacement.

Deletion checks for uncommitted files and unpushed commits. It asks for explicit
discard consent before removing a known dirty worktree. An offline deletion
records durable cleanup intent. On reconnect, cleanup removes clean worktrees
and retains worktrees with local work for explicit removal in Settings.
Automatic cleanup requires the Host's guarded removal capability. The same
conservative rule applies to unbound worktrees more than one day old.
Removing a checkout leaves the remote branch available on GitHub.

## Consequences

A disconnected Host can be cleaned up after the desktop restarts. Work that
cannot be inspected remains recoverable. Automatically committing changes or
forcing expiry-based cleanup would bypass the user's control of their work.
