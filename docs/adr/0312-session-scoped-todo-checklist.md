# ADR 0312: Session-scoped Todo checklist

- Status: Accepted for implementation
- Date: 2026-09-29
- Deciders: PI-Desktop maintainers
- Related: Issue #1177

## Context

Multi-step Agent work needs a durable, session-scoped progress checklist that
can be shown to the user without making the renderer a second source of truth.
The checklist must remain ordered, survive restart, and be isolated from
Plan/Goal contract negotiation and delegated subagent calls.

## Decision

`TodoWrite` is an Agent-only builtin tool. Its arguments contain the complete
ordered checklist and are validated by host-core.

The tool call is authorized against the calling session and its running turn
inside that transaction. The host emits `todos.changed` only after commit and
serves the complete committed snapshot through `todos.get`.

## Consequences

- Empty checklist writes remain observable through revision advancement.
- Session deletion cascades checklist rows; forks start with an empty checklist.
- Plan, Goal, delegated, plugin, and MCP execution paths cannot write the
  checklist through this contract.
- Context-compaction injection is deliberately deferred to a follow-up change.
- Remote Todo parity requires an additive RACP contract in a later change.
