# ADR 0206: Extend provider retries and show bounded progress

- Status: Accepted (amended 2026-09-20, issue #699; amended for opt-in infinite
  retry)
- Date: 2026-09-10
- Related: D378, ADR 0091, ADR 0128, ADR 0196

## Context

PI-Desktop owns provider retries so setup and mid-stream failures share one
counter instead of multiplying attempts through pi-ai, but five rate-limit and
four transient retries surfaced short outages earlier than the product wants,
and the active-turn row showed only the retry number without the remaining wait
or the position in the budget. A fault-injection report also showed a long task
stopping on its eleventh independent network failure after ten recoveries, which
made a per-turn budget the wrong scope.

## Decision

1. `PROVIDER_RATE_LIMITED` and admitted non-429 transient provider errors each
   get ten retries after the initial attempt, with setup and stream failures
   drawing from the same budget within their class and the two classes kept
   separate. Both counters reset after a complete successful model response,
   including a tool-call response; partial output, headers, and phase changes do
   not reset them.
2. `PROVIDER_RETRY_MAX_RETRIES` in `packages/shared` is the single budget
   constant for the main session, builtin subagents, and one-shot composer
   enhancement, with pi-ai's nested retry disabled. `AppSettings` may opt into
   `infiniteProviderRetry`, which skips only the retry-count ceiling for
   admitted network and transient failures; one-shots keep the bounded budget.
3. Delays are unchanged apart from the 8-second cap on the non-429 schedule
   after the first four waits, and provider headers, the 30-second 429 cap,
   abortability, failed-request-only replay, and terminal diagnostics stay as
   ADR 0091 and ADR 0128 define them.
4. The active-turn status renders a whole-second countdown from `retryDelayMs`
   and `since` plus the shared budget, for example
   `Retrying in 0s · attempt 9/10`, as a compact row that never creates
   intermediate transcript errors.

## Consequences

- Short outages recover inside a longer but still bounded same-turn window
  without duplicating assistant messages or lifecycle errors.
- Persistent failures surface later yet remain abortable and end in one
  structured terminal error; with infinite retry the turn stops only when the
  user cancels, so API usage may continue.
- The active wait and the retry budget appear in one status row, and no host
  protocol, storage schema, or nested SDK retry behavior changes.

## Alternatives

- Raise pi-ai's `maxRetries`: nested retries multiply attempts and reintroduce
  provider-controlled sleeping outside the abortable policy.
- Use one budget for rate limits and other transient failures: the two need
  different delay scales and should not consume each other's budget.
