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

## Decision

1. Non-429 transient provider failures share one bounded logical-turn budget of
   four retries after the initial attempt, for five provider attempts total.
2. The budget admits exactly `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and
   `PROVIDER_ERROR`.
3. Retry delay honors the server first.
4. The main session, builtin subagents, and one-shot composer enhancement use
   the same codes, the same budget size, and the same delay precedence.
5. Retries stay silent and abortable, and 429 keeps its own separate five-retry
   budget from ADR 0091.
6. Exhaustion emits one terminal assistant error and one lifecycle error, with
   `retryAttempt: 4` for a persistent non-429 transient failure.
7. Only the failed request is replayed.

## Consequences

- A short upstream 502/503/504 burst recovers without an error card, whether it
  lands before headers or mid-stream.
- A persistent upstream outage stays bounded and visible: five attempts, at most
  four backoffs totalling 15 seconds, and an individual wait capped at 8
  seconds.
- Worst-case latency before a terminal non-429 error grows, bounded by four
  waits (15 seconds of backoff) instead of one.
- Gateways that state their own pacing are respected, while malformed or
  excessive header values cannot hold a turn.
- The three provider entry points can no longer drift into different transient
  policies.

## Alternatives

- Raise pi-ai's `maxRetries` instead.
- Fold non-429 transient failures into the 429 budget.
- Retry every retriable classification three times.

## References

- `docs/spec/03-runtime/02-agent-runtime.md` §5d
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-096, E2E-149
- `docs/spec/08-meta/decisions-log.md` D259
- `packages/agent-runtime/src/provider-retry.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/subagent.ts`
- `packages/agent-runtime/src/prompt-enhancement.ts`
