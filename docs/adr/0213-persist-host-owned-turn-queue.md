# ADR 0213: Persist the Host-owned turn queue in host-core

- Status: Accepted
- Date: 2026-09-10
- Decision: D386
- Related: ADR 0205 (D375), `03-runtime/04-data-storage.md` §4.6b,
  `03-runtime/06-host-rpc-protocol.md`,
  `02-architecture/05-remote-agent-control.md` §6

## Context

D375 moved the per-session prompt queue out of renderer memory into the Host and
chose to persist it. The headless Agent Host module (`packages/agent-host`) owns
admission and draining, but it needs a store that survives a restart and never
starts work on its own.

## Decision

1. **Schema v15 adds `turn_queue`.** Columns: `id`, `session_id` (FK, cascade),
   `principal`, `idempotency_key`, `input_hash`, `content`, `attachments_json`,
   `permission_mode`, `position`, `created_at`; a per-session `position` index
   and a unique `(session_id, principal, idempotency_key)` index.
2. **Four additive RPC methods.** `session.queuePush` is idempotent on
   `(session, principal, idempotencyKey)`, returns the existing entry when the
   input hash matches, fails with `IDEMPOTENCY_CONFLICT` when a key is reused
   with other input, and fails with `AGENT_BUSY` when the session already holds
   eight entries.
3. **The store never decides execution.** The Agent Host module restores entries
   when host-core answers, holds every restored session until a controller
   attaches, and drains one entry only after the active turn's terminal event.
4. **The renderer's in-memory queue is retired.** The composer pushes through
   `agent/queue/push`, mirrors `agent/event/queueChanged`, and its "send now"
   uses `agent/queue/prioritize` to deliver promoted input into the current turn
   through steering (ADR 0265, issue #1607).
5. **Schema v20 extends queued input provenance.** `user_message_id` preserves
   the stable user row across queue recovery, and `voice_origin_json` records
   the originating Live Voice call and operation.

## Consequences

- A reboot no longer loses queued prompts; they reappear, held, in the
  snapshot's `queuedTurns`.
- Every client of a Host sees the same queue once the renderer switch lands.
- Deleting a session cascades to its queue entries.
- Fresh installs and every migration path produce the current schema; schema v15
  remains the original queue introduction, and schema v20 adds optional
  identity/provenance metadata without changing prior rows.

## Alternatives considered

- Keep the queue in Agent Host memory, as the D373 draft did.
- Persist in the renderer's `localStorage`.
