# ADR 0118: Keep queued prompts renderer-owned and stop runs at turn boundaries

- Status: Accepted (Implemented 2026-08-24)
- Date: 2026-08-24
- Related: Issue #11, ADR 0073

## Context

The host enforces one running turn per session, so disabling the composer
during that turn forces users to stall or abort a useful reply before giving
the next instruction. Storing a second prompt in host-core would add replay and
lifecycle ownership that a transient queue does not need.

## Decision

The renderer owns an in-memory FIFO queue keyed by session id, where each item
holds its visible prompt and composer draft snapshot so file references stay
independently removable; the queue is never persisted and is discarded on
restart or session deletion. Send and Stop coexist while a run is active: Send
appends a queue item, the renderer drains one item at a time after the owning
session receives `agent_end` via `agent/prompt`, and Send-first moves its item
to the head and calls the additive `agent/stop` IPC, which maps to
pi-agent-core's `finishTurn` so the durable turn closes as `completed`.
Immediate abort stays separate and leaves queued items untouched.

## Consequences

- Users queue next-turn instructions during a long run, and Send gets
  next-boundary semantics without a second durable turn or an `AGENT_BUSY`
  race.
- Queue contents are lost on restart by design.
- Graceful stop is only as precise as the pi-agent-core boundary, which lets an
  active provider stream finish.
