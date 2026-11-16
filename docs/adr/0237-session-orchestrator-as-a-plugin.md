# ADR 0237: Keep Session Orchestration in an Official Plugin

- Status: Accepted
- Date: 2026-09-13
- Updated: 2026-09-13
- Decision: D391
- Related: ADR 0200, ADR 0203, ADR 0208, ADR 0062, ADR 0089

## Context

Some tasks benefit from several independent Agents working at the same time, but
the existing `Task` family is intentionally a bounded in-process subagent
system. A new orchestration feature must not create a second session store,
bypass plugin permissions, or make the renderer an Agent runtime.

## Decision

Ship `pi.session-orchestrator` as an ordinary marketplace plugin. It registers
the `SessionTask` Agent Tool with `spawn`, `send`, `supervise`, `status`,
`wait`, `result`, `accept`, `cancel`, and `list` actions.

- `spawn` uses `session/create` followed by `agent/prompt`, creating a new
  durable session with no copied transcript.
- `send` reuses the recorded worker session.
- The plugin persists only the parent/worker relationship, task, status,
  timestamp, and bounded report in its private data directory.
- A parent may control only Worker Session IDs recorded under its own session
  id.
- Until a lifecycle subscription exists, `wait` performs one-second lightweight
  status polling with a 25-second default and 45-second maximum timeout.
- A simple `Agents` work-panel view lists workers and offers status refresh,
  Open Session, and Stop.

Two additive host primitives support these boundaries:

1. `session/create` accepts optional `inheritPermissionFromSessionId`.
2. The reviewed desktop catalog gains `session/open`, which validates and
   selects an existing durable session.

## Consequences

The parent can fan out real durable workers while every worker stays visible and
inspectable in the normal session UI.

The first version does not receive lifecycle events and therefore has bounded
polling latency.
