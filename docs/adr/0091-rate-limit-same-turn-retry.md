# ADR 0091: Route provider rate limits through bounded same-turn retry

- Status: Accepted
- Date: 2026-08-14 (amended 2026-08-19)
- Deciders: PI-Desktop core
- Related: D233, D245, E2E-149, ADR 0050, D186

## Context

A provider HTTP 429 caused by a transient rate limit can happen both before a
response is established and after a stream has already started. The old implementation
split those cases between pi-ai's one setup retry and the runtime's one
mid-stream replay. That exposed persistent but still-recoverable rate limits to
the user too early, and made the effective budget depend on which phase failed.

OpenCode's session retry policy provides the behavioral reference: rate limits
are retried silently with a finite maximum, provider retry headers take
precedence over client backoff, the wait is abortable, and only the exhausted
failure is rendered. PI-Desktop must keep that behavior without importing
OpenCode or multiplying retries through pi-ai's own wrapper.

## Decision

1. `PROVIDER_RATE_LIMITED` owns a runtime retry budget of five retries after the
   initial provider attempt. The budget is shared by request setup and stream
   recovery, so a turn has at most six provider attempts regardless of where
   the 429s occur. pi-ai's nested retry is disabled for this path.
2. Each 429 retry is silent and abortable. Delay precedence is
   `retry-after-ms`, `retry-after` seconds, `retry-after` HTTP-date, then
   OpenCode-style exponential backoff starting at 2 seconds with up to 25%
   positive jitter. Every server or calculated delay is capped at 30 seconds.
   The runtime captures status and headers from the underlying fetch because
   pi-ai's normal response callback does not expose failed responses.
3. A 429 before streaming is retried by the provider stream adapter. A 429
   after streaming starts is replayed by the runtime after removing the failed
   assistant from model context. Both paths use the same controller and the
   same budget. The captured response status is applied before classifying the
   provider message in both phases, so a generic 429 body still enters the 429
   budget while known non-retryable classifications remain terminal. The main
   session and every builtin subagent use this policy.
4. Intermediate assistant errors, lifecycle end events, and duplicate
   assistant bubbles are suppressed. A recovered attempt reuses the original
   visible assistant message id and emits one terminal lifecycle. The failed
   attempt is not persisted into the next model context.
5. Authentication, model-selection, malformed-request, context, and other
   non-retryable failures do not enter the 429 path. Existing non-429 transient
   behavior remains bounded separately: one setup retry and one mid-stream
   replay.
6. After the fifth 429 retry fails, the normal assistant error and lifecycle
   error are emitted once. Diagnostics retain the redacted provider error,
   `phase`, `providerStatus`, bounded wait/timing fields, and
   `retryAttempt: 5`. Aborting during a wait cancels the timer and prevents a
   later provider request.

## Consequences

- Short provider rate-limit bursts recover without an error card, toast, or
  manual action, whether the 429 arrives during setup or streaming.
- Persistent rate limiting remains bounded: six total attempts, at most five
  backoffs, and a maximum 30-second individual wait. The final failure stays
  visible and actionable.
- Retry headers from providers such as OpenAI-compatible gateways are honored,
  while malformed or excessive values cannot hold a turn indefinitely.
- Main sessions and subagents cannot drift into different rate-limit policies,
  and lifecycle consumers receive one coherent assistant turn.

## Alternatives

- Keep pi-ai's setup retry and add another runtime retry. Rejected: nested
  wrappers multiply attempts and make the budget phase-dependent.
- Retry every provider failure five times. Rejected: credentials, model ids,
  malformed requests, and context overflow are not repaired by repetition.
- Keep one same-turn retry and rely on the UI's manual action. Rejected: it
  surfaces transient 429s too early and defeats the OpenCode-style behavior
  requested for the provider boundary.

## References

- OpenCode session retry behavior (behavioral reference only)
- `docs/spec/03-runtime/02-agent-runtime.md` §5d
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-149
- `docs/spec/08-meta/decisions-log.md` D245
- `packages/agent-runtime/src/provider-retry.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/subagent.ts`
