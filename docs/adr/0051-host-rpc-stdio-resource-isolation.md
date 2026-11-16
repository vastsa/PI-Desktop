# ADR 0051: Isolate host RPC stdio from the Tokio blocking pool

- Status: Accepted
- Date: 2026-08-04

## Context

The host already bounded RPC tasks, tool classes, shell processes, and queued work,
yet a parallel Bash burst could still end it with
`Resource temporarily unavailable (os error 35)`, which Electron mapped to
`HOST_UNAVAILABLE`. The remaining risk was host-core's use of `tokio::io::stdin()`
and `tokio::io::stdout()`, which Tokio implements through its blocking pool: when the
OS refuses another worker thread the non-mandatory blocking spawn panics instead of
returning an I/O error, and the host exits with tool requests in flight. The Unix
login-shell PATH probe shared the problem through `std::thread::spawn` (D187).

## Decision

1. Host-core's NDJSON reader runs on one named `std::thread::Builder` thread and its
   writer on a second; the async dispatcher talks to them through channels, so request
   and tool tasks never call Tokio stdio adapters.
2. The control threads retry `EINTR` and transient `EAGAIN`/`EWOULDBLOCK`
   (`errno` 11 or 35) with a short bounded delay; the reader keeps partial input until
   a complete line arrives and the writer tracks partial writes so a retry cannot
   duplicate bytes.
3. Failure to create a control thread is a host startup error, and a closed or
   unrecoverable pipe ends the normal lifecycle under Electron's generation-aware
   supervision instead of becoming an unhandled thread-spawn panic.
4. The login-shell PATH probe also uses `thread::Builder`; if that optional helper
   cannot start, Bash falls back to the inherited host PATH. Admission limits are
   unchanged.

## Consequences

- Thread pressure no longer reaches the panic-on-no-worker stdio path, removing the
  observed cause behind `HOST_UNAVAILABLE`, and the host holds two long-lived control
  threads instead of a blocking-pool worker per stdio operation.
- NDJSON framing, response ordering, request concurrency, and overload codes are
  unchanged, and a genuinely unavailable pipe still ends the host under the existing
  restart policy.

## Alternatives

- Raise the blocking-pool limit: adds threads competing for the same exhausted
  resource and keeps the panic path.
- Catch the panic: brittle, and leaves partial writes and shutdown ordering implicit.
- Remove concurrency limits: they remain necessary for tools and subprocesses and do
  not address this control-pipe dependency.
