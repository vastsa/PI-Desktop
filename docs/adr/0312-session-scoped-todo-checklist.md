# ADR 0312: Session-scoped Todo checklist

- Status: Accepted for implementation
- Date: 2026-09-29
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
- Context-compaction injection is deliberately deferred to a follow-up change.
- Remote Todo parity requires an additive RACP contract in a later change.

## Verification

Host-core tests cover migration, validation, transaction rollback, restart,
revision ordering, fork isolation, cascade deletion, and RPC authorization.
Renderer type checks and TodoDock interaction tests cover revision filtering,
remote-session degradation, session switching, expansion, and bounded display.
