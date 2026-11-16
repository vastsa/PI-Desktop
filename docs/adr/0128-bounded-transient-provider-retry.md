# ADR 0128: Share one bounded budget for transient provider failures

- Status: Accepted
- Date: 2026-08-21
- Related: D186, D245, D259, ADR 0050, ADR 0091, E2E-096, E2E-149

## Context

OpenAI-compatible relays answer momentary upstream outages with a 502 that usually
succeeds on the next attempt, but ADR 0091 gave only HTTP 429 a shared budget and
left other transient failures on a split per-phase policy. A second 502 before
headers was terminal, a mid-stream gateway fault was never replayed, builtin
subagents required `phase === "request"`, and non-429 backoff ignored
`Retry-After`.

## Decision

Non-429 transient failures share one bounded logical-turn budget of four retries
after the initial attempt, with setup and stream delivery drawing on the same
budget so a fault moving between phases cannot reset or multiply it. The budget
admits exactly `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and `PROVIDER_ERROR` —
the last in the stream phase as well as setup — while every other classification,
including a non-retryable `PROVIDER_ERROR` from a malformed 400/422 request, stays
terminal. Server pacing wins: `retry-after-ms`, then `retry-after` seconds, then an
HTTP date, capped at 8 seconds, with headers retained for any status that can carry
a usable delay (429, 408, 409, 5xx) and a deterministic 1, 2, 4, 8 second doubling
schedule otherwise. Main session, builtin subagents, and one-shot composer
enhancement use the same codes, budget, and delay precedence, retries stay silent
and abortable, and 429 keeps ADR 0091's separate five-retry budget. Exhaustion
emits one terminal assistant error and one lifecycle error with `retryAttempt: 4`,
and only the failed request is replayed: the failed assistant leaves the next model
context with its visible message id reused, so a retry never restarts the turn or
re-runs a completed tool call.

## Consequences

- A short 502/503/504 burst recovers without an error card, before headers or
  mid-stream.
- A persistent outage stays bounded and visible, at the cost of up to 15 seconds of
  backoff before a terminal error.
- The three provider entry points can no longer drift into different policies.

## Alternatives

- Raise pi-ai's `maxRetries`: nested wrappers multiply attempts and reintroduce a
  non-abortable SDK sleep.
- Fold transient failures into the 429 budget: a 502 burst would consume the
  rate-limit budget.
