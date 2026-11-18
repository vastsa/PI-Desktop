# ADR 0091: Route provider rate limits through bounded same-turn retry

- Status: Accepted
- Date: 2026-08-14 (amended 2026-08-19)
- Related: D233, D245, ADR 0050, D186

## Context

A provider HTTP 429 can arrive before a response is established or after a stream
has started, and splitting those phases between pi-ai's setup retry and the
runtime's mid-stream replay surfaced recoverable rate limits too early and made
the effective budget depend on which phase failed. OpenCode's session retry
policy is the behavioral reference: silent finite retries, provider retry headers
ahead of client backoff, abortable waits, only the exhausted failure rendered.

## Decision

1. `PROVIDER_RATE_LIMITED` owns a runtime budget of five retries after the
   initial attempt, shared by setup and stream recovery, so a turn has at most six
   provider attempts; pi-ai's nested retry is disabled on this path.
2. Each retry is silent and abortable, with delay precedence `retry-after-ms`,
   `retry-after` seconds, `retry-after` HTTP-date, then exponential backoff from
   2 seconds with up to 25% jitter, every delay capped at 30 seconds.
3. A pre-stream 429 is retried by the provider stream adapter and a mid-stream
   429 is replayed by the runtime after removing the failed assistant from model
   context, both through the same controller and budget; the main session and
   every builtin subagent follow this policy.
4. Intermediate assistant errors, lifecycle end events, and duplicate assistant
   bubbles are suppressed: a recovered attempt reuses the original visible
   assistant id, emits one terminal lifecycle, and is not persisted into the next
   model context.
5. Authentication, model-selection, malformed-request, and context failures stay
   terminal, and existing non-429 transient behavior keeps its separate
   one-retry bounds.
6. After the fifth retry fails, the normal assistant and lifecycle errors are
   emitted once, diagnostics keep the redacted provider error plus `phase`,
   `providerStatus`, and `retryAttempt: 5`, and aborting during a wait cancels the
   timer and any later request.

## Consequences

- Short bursts recover without an error card, toast, or manual action, whether
  the 429 arrives during setup or streaming.
- Persistent rate limiting stays bounded at six attempts and a 30-second maximum
  individual wait, with the final failure visible and actionable.
- Provider retry headers are honored, and main sessions and subagents cannot
  drift into different policies or emit split assistant turns.

## Alternatives

- Keep pi-ai's setup retry and add another runtime retry: nested wrappers
  multiply attempts and make the budget phase-dependent.
- Retry every provider failure five times: credentials, model ids, and malformed
  requests are not repaired by repetition.
