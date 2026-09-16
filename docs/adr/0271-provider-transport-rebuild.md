# ADR 0271: Rebuild the shared provider transport after repeated unanswered failures

- Status: Accepted for implementation
- Date: 2026-09-16
- Related: [Error codes](../spec/03-runtime/08-error-codes.md) · [Agent runtime](../spec/03-runtime/02-agent-runtime.md) · [ADR 0212](0212-remove-diagnostic-timing-log-streams.md) · issue #234

## Context

One turn on a long session retried a Codex request ten times over ~112 seconds and
reported `NETWORK_ERROR: fetch failed` for every attempt; a new turn on the same
provider, model, and network succeeded immediately. The log record carried
`phase=stream`, `streamMs=1~2`, and `retryAttempt=10`, and nothing else.

Two readings of that evidence were possible, and the first one was wrong:

- `phase=stream` with a two-millisecond stream looks like a failure *after* the
  response headers arrived, which would mean the connection worked and the retry
  hypothesis is empty.
- The pair is actually the fingerprint of the opposite: pi-agent-core emits
  `message_start` for a stream that ended **without** ever emitting `start`, so
  `streamMs` measures the synthetic start/end pair, not a started stream. With
  `providerWaitMs=112442` covering the whole retry loop and each attempt spending
  seconds in `phase=request` retries, every one of the ten attempts died before
  any response.

The consequence of the wrong reading was that the shared transport was never
touched: `node-proxy.ts` installs one process-wide undici dispatcher (a
`ProxyAgent`, a SOCKS5 agent, or the plain agent) and `closeActiveDispatchers()`
ran only when settings changed. A pooled connection that died without the pool
noticing therefore stayed in use for the whole retry budget, and the first-hand
`error.cause` — where node and undici keep `ENOTFOUND`, `ECONNRESET`,
`UND_ERR_SOCKET`, or a TLS code — was already flattened into an `errorMessage`
string by pi-ai before classification, so the log could only say
`networkCategory: unknown`.

## Decision

1. Describe the rejected provider fetch where the original Error still exists:
   the fetch wrapper in `provider-retry.ts` runs `describeNetworkFailure` on the
   live cause chain and reports the same validated fields a directly classified
   network error carries (`networkCategory`, `networkCode`, `networkSyscall`,
   `networkHost`) instead of letting a bare `fetch failed` fall back to
   `unknown`. Field shapes, bounds, and redaction stay owned by
   `agent-errors.ts`; no new error code and no new locale string is introduced.
2. Report the transport route (`networkRoute`: `direct`, `environment-proxy`,
   `http-proxy`, `socks5-proxy`) with the diagnosis, so a failure at the proxy
   hop is readable without inferring it from an errno.
3. Report `phase: request` for a failure that never received a response. The
   phase describes what actually happened to the attempt, not which message
   lifecycle surfaced it.
4. Rebuild the shared transport when one origin fails this way **repeatedly**:
   after the second consecutive unanswered failure for the same origin inside a
   turn, once per streak, at most once every 30 seconds process-wide, never for a
   `dns` failure (name resolution happens before a socket exists). Rebuild means
   rebuilding the configured route from the settings already applied.
5. Swap before closing: the replacement dispatcher is installed, then the
   previous one is closed with `close()` — never `destroy()` — and the captured
   original-dispatcher reference is repointed if the closed pool was it. In-flight
   requests finish on the pool they were dispatched on.

## Consequences

- The next occurrence of issue #234 is diagnosable: the log names the layer and
  the route, and the retry indicator names the errno.
- A turn can now spend one of its retry attempts on a fresh pool, so a transport
  that never recovers on its own stops being reused. A rebuild does not change
  the retry budget, the backoff curve, or the error classification.
- Other sessions can observe a rebuild: their idle pooled sockets are closed, so
  their next request pays a new TCP/TLS handshake. That is a latency cost, never
  a correctness cost, and the 30-second throttle plus the per-origin streak bound
  it.
- A transport failure during a `dns` outage triggers no rebuild, which is
  deliberate: throttling the pool would spend the cost for no possible benefit.

## Alternatives considered

- **Rebuild on every failure.** Rejected: the dispatcher is process-wide, so one
  session's single transient failure would churn every other session's pool, and
  a long outage would rebuild once per attempt.
- **Never rebuild.** Rejected: it leaves a repeated unanswered failure on the
  same origin with no recovery path, which is exactly the reported behavior.
- **Per-session dispatchers.** Rejected for this change: it changes the ownership
  model of the transport and the proxy/bypass composition for every provider
  request, which is a larger and separate architectural decision.
- **Retain the raw cause message and its `name`.** Rejected: it would put
  free-form provider text (URLs, header values, query strings) into logs and the
  transcript for a small diagnostic gain over the errno, the category, and the
  route.
