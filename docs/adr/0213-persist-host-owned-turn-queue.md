# ADR 0213: Persist the Host-owned turn queue in host-core

- Status: Accepted
- Date: 2026-09-10
- Decision: D386
- Related: ADR 0205 (D375), `03-runtime/04-data-storage.md` §4.6b,
  `03-runtime/06-host-rpc-protocol.md`,
  `02-architecture/05-remote-agent-control.md` §6

## Context

D375 moved the per-session prompt queue out of renderer memory into the Host
and chose to persist it. The headless Agent Host module
(`packages/agent-host`) owns admission and draining, but it needs a store
that survives a restart and never starts work on its own. Rust host-core
owns SQLite exclusively (frozen decision 12), so the store is a host-core
table and RPC surface, not a file the module writes.

## Decision

1. **Schema v15 adds `turn_queue`.** Columns: `id`, `session_id` (FK,
   cascade), `principal`, `idempotency_key`, `input_hash`, `content`,
   `attachments_json`, `permission_mode`, `position`, `created_at`; a
   per-session `position` index and a unique
   `(session_id, principal, idempotency_key)` index. The v14→v15 migration
   is additive: it creates the table and indexes, every existing chain gains
   the step, and a `pi.sqlite.v14.bak` copy is kept like every prior
   migration.
2. **Four additive RPC methods.** `session.queuePush` is idempotent on
   `(session, principal, idempotencyKey)`, returns the existing entry when
   the input hash matches, fails with `IDEMPOTENCY_CONFLICT` when a key is
   reused with other input, and fails with `AGENT_BUSY` when the session
   already holds eight entries. `session.queueList` returns one session's
   entries or every entry in position order. `session.queueRemove` deletes
   one entry. `session.queuePrioritize` moves one entry to the head of its
   session (the desktop's "send now", RACP `turn/prioritize`). Protocol
   version stays v11.
3. **The store never decides execution.** The Agent Host module restores
   entries when host-core answers, holds every restored session until a
   controller attaches, and drains one entry only after the active turn's
   terminal event. The startup fence still never replays or auto-starts
   work.
4. **The renderer's in-memory queue is retired.** The composer pushes
   through `agent/queue/push`, mirrors `agent/event/queueChanged`, and its
   "send now" is `agent/queue/prioritize` followed by a graceful stop.

## Consequences

- A reboot no longer loses queued prompts; they reappear, held, in the
  snapshot's `queuedTurns`.
- Every client of a Host sees the same queue once the renderer switch
  lands.
- Deleting a session cascades to its queue entries.
- Fresh installs and every migration path produce schema v15; the
  `04-data-storage.md` chain, the baseline, and the README move to v15.

## Alternatives considered

- Keep the queue in Agent Host memory, as the D373 draft did. Rejected by
  D375: a restart loses prompts.
- Persist in the renderer's `localStorage`. Rejected: invisible to other
  clients and to a headless Host.
