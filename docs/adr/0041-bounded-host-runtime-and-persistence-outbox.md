# ADR 0041: Bound host runtime resources and decouple message persistence

- Status: Accepted
- Date: 2026-08-01

## Context

The Rust host spawned an unbounded Tokio task per RPC and unbounded shell
processes. A local burst produced `Resource temporarily unavailable`, concurrent
restarts, and writes to a destroyed stdio pipe, so persistence errors hid the
original failure.

## Decision

Host-core bounds RPC and tool admission: independent global limits per tool
class, a per-session limit, a finite queue, bounded backoff on transient spawn
failures, no retry of started commands, and reaping of timed-out children before
permits are released.

Electron supervision is single-flight and generation-aware, so a stale generation
cannot notify or accept RPC writes. Appends pass through an Electron-main-owned
file-backed outbox flushed sequentially after a successful handshake, and the
handshake **awaits** that drain before the host is ready, so a cold `session.get`
cannot race a queued row (D327). Append is idempotent by message id, and a
colliding id owned by another session is remapped to `{sessionId}:{id}` before
the JSONL write (D444). `UNIQUE constraint failed: messages.id` is an ack, a
`PERMISSION_DENIED:` append is dropped (D597), and an unclassifiable refusal is
retried on bounded backoff and then quarantined into an application-owned
dead-letter file (D656).

## Consequences

- A burst is backpressured instead of exhausting process resources, and one
  failed host no longer causes a restart storm.
- SQLite ownership stays in host-core; the data directory gains one small outbox
  file, and a missing sessions row is restored from the live JSONL or created as
  a stub that `session.delete` clears (D318).

## Alternatives

- Raise the restart count: masks the leak and amplifies the crash loop.
- A semaphore only around `Bash`: leaves RPC, plugin, read, and persistence
  fan-out unbounded.
- In-memory-only buffering: loses messages if Electron exits before host recovery.
