# ADR 0271: Rebuild the shared provider transport after repeated unanswered failures

- Status: Accepted for implementation
- Date: 2026-09-16
- Related: [Error codes](../spec/03-runtime/08-error-codes.md) ·
  [ADR 0212](0212-remove-diagnostic-timing-log-streams.md) · Issue #234

## Context

A turn on a long session retried a Codex request ten times and reported
`NETWORK_ERROR: fetch failed` each time, while a new turn on the same provider,
model, and network succeeded at once. The log record showed `phase=stream` with
`streamMs=1~2`, which read like a failure after the response headers arrived; it
is in fact the fingerprint of the opposite, because pi-agent-core emits
`message_start` for a stream that ended without ever starting, so every attempt
died before a response. The shared transport was therefore never touched: one
process-wide undici dispatcher serves all providers and was rebuilt only on
settings change, so a pooled connection that died unnoticed stayed in use for the
whole retry budget, and the first-hand `error.cause` had already been flattened
into an `errorMessage` string, leaving `networkCategory: unknown`.

## Decision

1. Describe the rejected provider fetch where the original Error still exists: the
   fetch wrapper in `provider-retry.ts` runs `describeNetworkFailure` on the live
   cause chain and reports the same validated fields a classified network error
   carries (`networkCategory`, `networkCode`, `networkSyscall`, `networkHost`),
   with shapes, bounds, and redaction still owned by `agent-errors.ts`.
2. Report the transport route as `networkRoute` (`direct`, `environment-proxy`,
   `http-proxy`, `socks5-proxy`), so a failure at the proxy hop is readable without
   inferring it from an errno.
3. Report `phase: request` for a failure that never received a response, because
   the phase describes what happened to the attempt rather than which message
   lifecycle surfaced it.
4. Rebuild the shared transport when one origin fails this way repeatedly: after
   the second consecutive unanswered failure for the same origin inside a turn,
   once per streak, at most once every 30 seconds process-wide, and never for a
   `dns` failure.
5. Swap before closing: the replacement dispatcher is installed, then the previous
   one is closed with `close()` rather than `destroy()`, and in-flight requests
   finish on the pool they were dispatched on.

## Consequences

- A later occurrence of issue #234 is diagnosable, because the log names the layer
  and route and the retry indicator names the errno.
- A turn can spend one retry attempt on a fresh pool, while the retry budget,
  backoff curve, and error classification stay unchanged.
- Other sessions may pay a new TCP/TLS handshake after a rebuild, a latency cost
  bounded by the throttle and the per-origin streak.

## Amendment: certificate verification (issue #714)

Recognized certificate verification errors also skip rebuilding. Unlike the
broader TLS/protocol category they cannot be repaired by replacing a socket pool;
see [system certificate trust](provider-system-certificates.md).

## Alternatives

- Rebuild on every failure — rejected: the dispatcher is process-wide, so one
  transient failure would churn every session's pool.
- Per-session dispatchers — rejected here: it changes transport ownership and
  proxy composition for every request.
