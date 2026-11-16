# ADR 0213: Persist the Host-owned turn queue in host-core

- Status: Accepted
- Date: 2026-09-10
- Decision: D386
- Related: ADR 0205 (D375), `03-runtime/04-data-storage.md` §4.6b, `03-runtime/06-host-rpc-protocol.md`, `02-architecture/05-remote-agent-control.md` §6

## Context

D375 moved the per-session prompt queue out of renderer memory into the Host and
chose to persist it. The headless Agent Host module owns admission and draining
but needs a store that survives a restart and never starts work on its own, and
host-core owns SQLite exclusively (frozen decision 12).

## Decision

1. An additive schema migration adds `turn_queue` with a per-session `position`
   index and a unique `(session_id, principal, idempotency_key)` index, so
   existing chains gain only the new step.
2. Four additive RPC methods: `session.queuePush`, idempotent on
   `(session, principal, idempotencyKey)`, returning the existing entry for a
   matching input hash and failing with `IDEMPOTENCY_CONFLICT` on key reuse with
   other input or `AGENT_BUSY` at the per-session limit; `session.queueList`;
   `session.queueRemove`; and `session.queuePrioritize`, which moves an entry to
   the head of its session as RACP `turn/prioritize`. The protocol version does
   not change.
3. The store never decides execution: the Agent Host restores entries, holds a
   restored session until a controller attaches, drains one entry only after the
   active turn's terminal event, and never replays or auto-starts work.
4. The renderer's in-memory queue is retired in favor of `agent/queue/push`,
   `agent/event/queueChanged`, and `agent/queue/prioritize` for "send now"
   (ADR 0265, issue #1607).
5. Queued input keeps provenance through the nullable `user_message_id` and
   `voice_origin_json` columns, added by an additive migration.

## Consequences

- Queued prompts survive a reboot and reappear, held, as `queuedTurns`.
- Every client of a Host sees the same queue; deleting a session cascades to
  its entries.
- Fresh installs and every migration path reach the current schema.

## Alternatives

- Keep the queue in Agent Host memory, as the D373 draft did: rejected by D375,
  because a restart loses prompts.
- Persist in renderer `localStorage`: rejected, it is invisible to other clients
  and to a headless Host.
