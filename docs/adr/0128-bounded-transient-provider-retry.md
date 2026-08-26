# ADR 0128: Share one bounded budget for transient provider failures

- Status: Accepted
- Date: 2026-08-21
- Deciders: PI-Desktop core
- Related: D259, E2E-096, E2E-149, ADR 0050, ADR 0091, D186, D245

## Context

Upstream gateway faults are common on OpenAI-compatible endpoints. A relay that
answers `OpenAI API error (502): {"type":"api_error","message":"Upstream API
request failed."}` is reporting a momentary upstream outage, not a rejected
request: the same prompt usually succeeds on the next attempt.

ADR 0091 gave HTTP 429 a shared five-retry budget but deliberately left every
other transient failure on the older split policy: one retry during request
setup and one mid-stream replay, each guarded by its own boolean. Two gaps
followed. First, a 502 that arrived before headers consumed the single setup
retry, so a second 502 became a terminal error card even though a third attempt
would likely have succeeded. Second, the stream phase excluded `PROVIDER_ERROR`
entirely, so a mid-stream gateway fault was never replayed at all. Builtin
subagents were stricter still: their claim required `phase === "request"`, so a
delegate failed on the first mid-stream transient error. The three provider
entry points (main session, subagent, composer enhancement) had drifted into
three different policies.

The non-429 backoff also ignored `Retry-After`. Gateways that emit 502/503 with
an explicit `Retry-After` were retried on a fixed 750 ms mid-stream timer or a
500 ms setup timer regardless of what the server asked for.

## Decision

1. Non-429 transient provider failures share one bounded logical-turn budget of
   three retries after the initial attempt, for four provider attempts total.
   The budget is shared by request setup and stream delivery, so a fault that
   moves between phases cannot reset or multiply it.
2. The budget admits exactly `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and
   `PROVIDER_ERROR`. `PROVIDER_ERROR` is now admitted in the stream phase as
   well as during setup. Every other classification, including a non-retryable
   `PROVIDER_ERROR` from a malformed 400/422 request, stays terminal.
3. Retry delay honors the server first. `retry-after-ms`, `retry-after` seconds,
   then `retry-after` HTTP-date take precedence over client backoff, capped at
   8 seconds for the non-429 path. Captured response headers are retained for
   any status that can carry a usable delay (429, 408, 409, and 5xx) instead of
   429 alone. Without a usable header the delay keeps its exponential shape and
   grows per attempt; the mid-stream replay keeps its 750 ms floor.
4. The main session, builtin subagents, and one-shot composer enhancement use
   the same codes, the same budget size, and the same delay precedence.
5. Retries stay silent and abortable, and 429 keeps its own separate five-retry
   budget from ADR 0091. The two budgets do not draw from each other.
6. Exhaustion emits one terminal assistant error and one lifecycle error, with
   `retryAttempt: 3` for a persistent non-429 transient failure.

## Consequences

- A short upstream 502/503/504 burst recovers without an error card, whether it
  lands before headers or mid-stream.
- A persistent upstream outage stays bounded and visible: four attempts, at most
  three backoffs, and an individual wait capped at 8 seconds.
- Worst-case latency before a terminal non-429 error grows, bounded by three
  waits instead of one.
- Gateways that state their own pacing are respected, while malformed or
  excessive header values cannot hold a turn.
- The three provider entry points can no longer drift into different transient
  policies.

## Alternatives

- Raise pi-ai's `maxRetries` instead. Rejected for the reason recorded in
  ADR 0091: nested wrappers multiply attempts, make the budget phase-dependent,
  and reintroduce a non-abortable SDK sleep.
- Fold non-429 transient failures into the 429 budget. Rejected: a rate limit
  and a gateway outage want different delay scales, and one shared counter would
  let a 502 burst consume the rate-limit budget.
- Retry every retriable classification three times. Rejected: `EMPTY_MODEL_RESPONSE`
  and context failures have their own recovery paths, and re-sending the same
  request does not repair them.

## References

- `docs/spec/03-runtime/02-agent-runtime.md` §5d
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-096, E2E-149
- `docs/spec/08-meta/decisions-log.md` D259
- `packages/agent-runtime/src/provider-retry.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/subagent.ts`
- `packages/agent-runtime/src/prompt-enhancement.ts`
