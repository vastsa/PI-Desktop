# ADR 0312: Session-scoped Todo checklist

- Status: Accepted for implementation
- Date: 2026-09-29
- Amended: 2026-10-01 (compaction checkpoint copy)
- Deciders: PI-Desktop maintainers
- Related: Issue #1177

## Context

Multi-step Agent work needs a durable, session-scoped progress checklist that can
be shown to the user without making the renderer a second source of truth. The
checklist must remain ordered, survive restart, and be isolated from Plan/Goal
contract negotiation and delegated subagent calls.

## Decision

`TodoWrite` is an Agent-only builtin tool. Its arguments contain the complete
ordered checklist and are validated by host-core. The host owns persistence in
SQLite schema v21: `session_todo` stores the rows, while `sessions.todo_revision`
and `sessions.todo_updated_at` order both populated and empty snapshots. Each
write replaces the rows and increments the revision in one transaction.

The tool call is authorized against the calling session and its running turn
inside that transaction. The host emits `todos.changed` only after commit and
serves the complete committed snapshot through `todos.get`. Electron Main
forwards the notification through the existing IPC bridge, and the renderer
keeps snapshots keyed by session id while rejecting stale revisions.

The Composer TodoDock is a non-focusing, session-aware presentation surface.
It shows bounded progress and at most eight ordered rows. Remote RACP sessions
remain local-only for this vertical slice because RACP v1 has no Todo snapshot
operation; the renderer skips local recovery for those session ids rather than
reading the local database.

## Consequences

- Empty checklist writes remain observable through revision advancement.
- Session deletion cascades checklist rows; forks start with an empty checklist.
- Plan, Goal, delegated, plugin, and MCP execution paths cannot write the
  checklist through this contract.
- A compaction checkpoint carries one copy of the checklist for the model (see
  the 2026-10-01 amendment); the host table remains the only authority.
- Remote Todo parity requires an additive RACP contract in a later change.

## Amendment 2026-10-01: compaction checkpoint copy

Compaction summarizes the `TodoWrite` calls that kept the checklist current, so
after a checkpoint the model lost which steps were done and could rebuild a
second list. When the agent runtime installs a checkpoint it reads `todos.get`
for its own session once, through the sidecar host proxy, and stores
`{ revision, updatedAt, todos }` in the checkpoint's opaque
`details.todoSnapshot` only when pending or in-progress items remain. The model
context renders it after the checkpoint summary as a `<session_checklist>`
block; the stored summary is unchanged, so a later compaction never carries a
stale list forward and the transcript compaction row does not show it.

The copy is persisted with the checkpoint and therefore survives restart, is
written once per checkpoint rather than injected on every request, and stays
inside the post-compaction prefix. It is never read by the renderer. A later
`TodoWrite` call supersedes it. A failed read, an older host, a native Pi
session, or a finished list installs the checkpoint without a copy, and the copy
is dropped rather than pushing an otherwise fitting checkpoint over the safe
context budget. `todos.get` is the only addition to the sidecar proxy allowlist;
it is read-only, and checklist writes still go through host-authorized
`TodoWrite`. Approved Plan and Goal execution instructions ask the model to keep
the checklist current.

## Verification

Host-core tests cover migration, validation, transaction rollback, restart,
revision ordering, fork isolation, cascade deletion, and RPC authorization.
Renderer type checks and TodoDock interaction tests cover revision filtering,
remote-session degradation, session switching, expansion, and bounded display.
