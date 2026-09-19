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
and are flushed sequentially after a successful host handshake. The handshake
**awaits** that drain before the host is advertised ready, so a cold
`session.get` cannot race a queued assistant/tool row (D327). Host-side
message append is idempotent by message id. A colliding id that already belongs
to another session is remapped to `{sessionId}:{id}` before the JSONL write
(D444). The outbox treats `UNIQUE constraint failed: messages.id` as an ack,
not a pause. A permanently rejected append (`PERMISSION_DENIED:` provenance
or permission on that row) is dropped the same way so one poison head cannot
block later transcript rows (D597). The outbox's 1024-entry threshold is a
backlog warning, not permission to drop an already-produced message. Overflow
is persisted in the same recovery file; per-session turn settlement blocks
subsequent prompts until that session's writes finish. This preserves restart
recovery without introducing an in-memory-only overflow queue. A sustained
outage can grow the recovery file with already-running work; protecting those
completed messages takes precedence over the former silent-drop cap (#597).

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
