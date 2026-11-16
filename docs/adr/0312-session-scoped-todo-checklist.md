# ADR 0312: Session-scoped Todo checklist

- Status: Accepted for implementation
- Date: 2026-09-29
- Related: Issue #1177

## Context

Multi-step Agent work needs a durable, ordered, session-scoped checklist that
survives restart and stays isolated from Plan/Goal contract negotiation and
delegated subagent calls, without making the renderer a second source of truth.

## Decision

`TodoWrite` is an Agent-only builtin tool whose arguments carry the complete
ordered checklist, validated by host-core, which owns persistence in SQLite
schema v21: `session_todo` stores the rows while `sessions.todo_revision` and
`sessions.todo_updated_at` order populated and empty snapshots, each write
replacing the rows and incrementing the revision in one transaction. The call is
authorized against the calling session and its running turn inside that
transaction, the host emits `todos.changed` only after commit, and `todos.get`
serves the committed snapshot, which the renderer keys by session id and filters
by revision. The Composer TodoDock shows bounded progress and the complete
ordered list scrolled inside its own box, and remote RACP sessions stay
local-only because RACP v1 has no Todo snapshot operation.

## Consequences

- Empty checklist writes stay observable through revision advancement, session
  deletion cascades the rows, and forks start empty.
- Plan, Goal, delegated, plugin, and MCP paths cannot write the checklist
  through this contract.
- Context-compaction injection and remote parity are deferred, the latter
  needing an additive RACP contract.
