# ADR 0051: Isolate host RPC stdio from the Tokio blocking pool

- Status: Accepted
- Date: 2026-08-04

## Context

The host already bounds RPC tasks, tool classes, shell processes, and queued
work. A parallel bash burst could nevertheless end the host with
`Resource temporarily unavailable (os error 35)`. Electron correctly mapped
that child exit to `HOST_UNAVAILABLE`, but the mapping hid the process-level
failure from the session.

The remaining control-path risk was host-core's use of
`tokio::io::stdin()` and `tokio::io::stdout()`. Tokio implements these adapters
through its blocking pool. When the OS refuses another worker thread, the
non-mandatory blocking spawn path panics instead of returning an ordinary I/O
error. The host then exits while tool requests are in flight. The Unix login
shell PATH probe had a second version of the same problem because an ordinary
`std::thread::spawn` can panic when the OS cannot create a thread.

## Decision

1. Host-core's NDJSON stdin reader runs on one named thread created with
   `std::thread::Builder`. Its stdout writer runs on a second named thread.
   The async RPC dispatcher communicates with those threads through channels;
   request and tool tasks never call Tokio stdio adapters.
2. The control threads retry `EINTR` and transient `EAGAIN`/`EWOULDBLOCK`
   (`errno` 11 or 35) with a short bounded delay. The reader preserves partial
   input until a complete line arrives, and the writer tracks partial writes so
   a retry cannot duplicate bytes.
3. Failure to create a control thread is returned as a host startup error. A
   closed or unrecoverable pipe ends the normal host lifecycle and remains
   visible to Electron's generation-aware supervision; it is never converted
   into an unhandled Rust thread-spawn panic.
4. The login-shell PATH probe also uses `thread::Builder`; if that optional
   helper cannot start, bash falls back to the inherited host PATH. Existing
   RPC and tool admission limits are unchanged.

## Consequences

- Temporary OS thread pressure no longer reaches Tokio's panic-on-no-worker
  stdio path, removing the observed host exit cause behind `HOST_UNAVAILABLE`.
- The host has two long-lived control threads instead of creating a blocking
  pool worker per stdio operation.
- NDJSON framing, response ordering, request concurrency, and overload codes
  remain unchanged.
- A genuinely unavailable stdin/stdout pipe still ends the host and is
  handled by the existing Electron restart/fatal-degradation policy.

## Alternatives

### Increase the Tokio blocking-pool limit

Rejected. It raises the number of threads competing for the same exhausted OS
resource and leaves the panic-on-thread-creation path intact.

### Keep Tokio stdio and catch the panic

Rejected. Catching a panic around the async runtime would be brittle and would
not make partial NDJSON writes or shutdown ordering explicit.

### Remove concurrency limits instead

Rejected. Admission limits remain necessary for tools and subprocesses; they
do not solve the independent control-pipe dependency on dynamic blocking-pool
workers.

## References

- `crates/host-core/src/rpc/mod.rs`
- `crates/host-core/src/tools/shell.rs`
- `docs/spec/03-runtime/05-host-core-rust.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/03-runtime/07-process-model.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- Decision D187
