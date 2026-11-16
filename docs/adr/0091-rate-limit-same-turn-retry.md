# ADR 0091: Route provider rate limits through bounded same-turn retry

- Status: Accepted
- Date: 2026-08-14 (amended 2026-08-19)
- Deciders: PI-Desktop core
- Related: D233, D245, E2E-149, ADR 0050, D186

## Context

A provider HTTP 429 caused by a transient rate limit can happen both before a
response is established and after a stream has already started. The old
implementation split those cases between pi-ai's one setup retry and the
runtime's one mid-stream replay.

## Decision

1. `PROVIDER_RATE_LIMITED` owns a runtime retry budget of five retries after the
   initial provider attempt.
2. Each 429 retry is silent and abortable.
3. A 429 before streaming is retried by the provider stream adapter.
4. Intermediate assistant errors, lifecycle end events, and duplicate assistant
   bubbles are suppressed.
5. Authentication, model-selection, malformed-request, context, and other
   non-retryable failures do not enter the 429 path.
6. After the fifth 429 retry fails, the normal assistant error and lifecycle
   error are emitted once.

## Consequences

- Short provider rate-limit bursts recover without an error card, toast, or
  manual action, whether the 429 arrives during setup or streaming.
- Persistent rate limiting remains bounded: six total attempts, at most five
  backoffs, and a maximum 30-second individual wait.
- Retry headers from providers such as OpenAI-compatible gateways are honored,
  while malformed or excessive values cannot hold a turn indefinitely.
- Main sessions and subagents cannot drift into different rate-limit policies,
  and lifecycle consumers receive one coherent assistant turn.

## Alternatives

- Keep pi-ai's setup retry and add another runtime retry.
- Retry every provider failure five times.
- Keep one same-turn retry and rely on the UI's manual action.

## References

- OpenCode session retry behavior (behavioral reference only)
- `docs/spec/03-runtime/02-agent-runtime.md` §5d
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-149
- `docs/spec/08-meta/decisions-log.md` D245
- `packages/agent-runtime/src/provider-retry.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/subagent.ts`
