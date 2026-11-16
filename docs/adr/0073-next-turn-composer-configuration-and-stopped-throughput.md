# ADR 0073: Stage next-turn composer configuration and preserve stopped throughput

- Status: Accepted for implementation
- Date: 2026-08-11
- Amends: D189
- Related: D212

## Context

The composer made draft, mode, thinking, and permission controls read-only for a
whole run, so users could not prepare the next prompt, while the real safety rule
is only that host-core must not mutate configuration pinned by an in-flight turn.
A user Stop could also arrive before final provider usage, leaving stopped answers
without stream duration or output counts.

## Decision

1. During an active turn the draft and the mode, thinking, and permission
   selectors stay editable; Send alone is disabled, Stop stays available, and a
   pending Plan/Goal approval keeps blocking the draft and configuration controls.
2. The renderer keeps the latest full session configuration per running session
   and, on `agent_end`, `error`, or compaction completion, submits it through the
   existing idle-only `session/configure` API, newer selections replacing queued
   ones without touching the running runtime.
3. Runtime terminal messages preserve `responseDurationMs`, and an aborted
   response without positive provider output usage gets an estimated optional
   `responseOutputTokens` counted at four code points per token over visible
   thinking plus answer text.
4. Rust transcript conversion persists both optional fields in message metadata,
   exact provider usage wins over the estimate, the estimate stays labeled, and
   records without either field remain valid.

## Consequences

- Users prepare the next request and its operating profile without sending
  concurrently.
- Idle-only admission, one turn per session, Plan/Goal approval, and permission
  enforcement are unchanged.
- Stopped answers show a stable approximate tokens-per-second value after reload,
  and the additive field changes neither protocol v9 nor storage schema v11.

## Alternatives

- Configure the host while running: rejected because it breaks idle-only
  admission or mutates pinned turn configuration.
- Hide throughput without final usage: rejected because output and stream interval
  already support a labeled estimate.
