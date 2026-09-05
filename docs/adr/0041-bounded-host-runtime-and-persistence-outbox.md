# ADR 0041: Bound host runtime resources and decouple message persistence

- Status: Accepted
- Date: 2026-08-01

## Context

The Rust host previously spawned an unbounded Tokio task for every RPC and
could start an unbounded number of shell processes. During a local burst this
produced `Resource temporarily unavailable`, followed by concurrent host
restarts and writes to a destroyed stdio pipe. The resulting persistence
errors obscured the original resource failure.

## Decision

Host-core owns a bounded admission budget for RPC and tool execution. Tool
classes have independent global limits, every session has a limit, and the
queue is finite. Transient process-spawn resource failures receive bounded
backoff; started commands are never automatically retried. Timed-out children
are reaped before their permits are released.

Electron host supervision is single-flight and generation-aware. A stale host
generation cannot issue notifications or accept new RPC writes. Assistant and
tool message appends pass through an Electron-main-owned, file-backed outbox
and are flushed sequentially after a successful host handshake. Host-side
message append is idempotent by message id.

## Consequences

- A burst is rejected or backpressured instead of exhausting process resources.
- One failed host does not create a restart storm or hundreds of stale-pipe
  errors.
- SQLite ownership remains exclusively in host-core.
- The application data directory gains one small recovery outbox file.
- A missing sessions row is restored from the live JSONL (or created as a
  stub under the same id) so a queued outbox can drain; `session.delete`
  drops that session's outbox entries so a stub cannot resurrect a deleted
  conversation (D318).
- Tool capacity becomes observable through `app.health` and structured logs.

## Alternatives rejected

- Raising the restart count: masks the resource leak and amplifies the crash
  loop.
- A semaphore only around `Bash`: leaves RPC, plugin, read, and persistence
  fan-out unbounded.
- In-memory-only persistence buffering: loses messages if Electron exits before
  host recovery.
