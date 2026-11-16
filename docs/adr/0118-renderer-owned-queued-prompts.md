# ADR 0118: Keep queued prompts renderer-owned and stop runs at turn boundaries

- Status: Accepted (Implemented 2026-08-24)
- Date: 2026-08-24
- Related: Issue #11, ADR 0073

## Context

The desktop host enforces one running turn per session. Disabling the composer
while that turn runs makes users wait or abort a useful reply before they can
provide the next instruction.

## Decision

The renderer owns an in-memory FIFO queue keyed by session id. A queued item
contains its visible prompt and composer draft snapshot, so file references
remain independently removable and can be sent through the normal prompt
channel.

The Send and Stop controls coexist while a run is active. A normal Send adds a
queue item.

## Consequences

- Users can continue typing and queue multiple next-turn instructions while a
  long model/tool run is active.
- Send now has precise next-boundary semantics without a second concurrent
  durable turn or an `AGENT_BUSY` race.
- Queue contents are intentionally lost on restart and are not visible to
  another session; persistence can be considered separately if a future product
  requirement needs it.
- Graceful stop is only as precise as the pi-agent-core boundary: an active
  provider stream is allowed to finish, while a pending permission can still
  wait for its normal resolution.
