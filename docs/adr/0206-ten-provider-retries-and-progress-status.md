# ADR 0206: Extend provider retries and show bounded progress

- Status: Accepted
- Date: 2026-09-10
- Deciders: PI-Desktop core
- Related: D378, E2E-096, E2E-149, ADR 0091, ADR 0128, ADR 0196

## Context

PI-Desktop already owns provider retries so request setup and mid-stream
failures share one counter and pi-ai does not multiply attempts through a
nested retry loop. The current budgets of five rate-limit retries and four
other transient retries still surface short provider outages earlier than the
product's target behavior. The active-turn row also shows only the retry
number, so it does not tell the user how long the current wait is or where the
retry sits in the budget.

## Decision

1. `PROVIDER_RATE_LIMITED` and the admitted non-429 transient provider errors
   each receive a shared budget of ten retries after the initial provider
   attempt. Setup and stream failures continue to draw from the same budget
   within their class, for at most eleven provider attempts. The two classes
   remain separate.
2. `PROVIDER_RETRY_MAX_RETRIES` in `packages/shared` is the single budget
   constant used by the runtime and renderer. The main session, builtin
   subagents, and one-shot composer enhancement continue to use the same retry
   budgets and classifications. pi-ai's nested retry remains disabled.
3. Delay behavior is unchanged except that the non-429 schedule remains at its
   8-second cap for retries after the first four waits. Provider headers, the
   30-second 429 cap, abortability, failed-request-only replay, and terminal
   diagnostics remain as defined by ADR 0091 and ADR 0128.
4. The active-turn retry status uses the current `retryDelayMs` and `since` to
   render a whole-second countdown and shows the shared budget, for example
   `Retrying in 0s · attempt 9/10`. It remains a compact status row and does
   not create intermediate transcript errors.
5. Authentication, model-selection, malformed-request, context, mutation,
   compaction, and other non-provider recovery policies are unchanged.

## Consequences

- Short provider outages can recover through a longer, still bounded same-turn
  window without duplicating assistant messages or lifecycle errors.
- Persistent provider failures take longer to surface, but remain abortable and
  end with one structured terminal error after the retry budget is exhausted.
- Users can see the active wait and the retry budget in the same status row,
  including during the final retry.
- No host protocol, storage schema, provider configuration, or nested SDK retry
  behavior changes.

## Alternatives

### Increase pi-ai's `maxRetries`

Rejected because nested retries would multiply attempts, obscure phase sharing,
and reintroduce provider-controlled sleeping outside the runtime's abortable
policy.

### Use one budget for rate limits and other transient failures

Rejected because rate limits and upstream outages need different delay scales,
and one class should not consume the other's recovery budget.

### Show only a fixed `/10` label

Rejected because the status already carries the delay and start time needed for
an accurate countdown; deriving the remaining seconds keeps the UI useful while
waiting instead of showing stale information.

## References

- `docs/spec/03-runtime/02-agent-runtime.md` §5d
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-096, E2E-149
- `docs/spec/08-meta/decisions-log.md` D378
- `packages/shared/src/provider-retry.ts`
- `packages/agent-runtime/src/provider-retry.ts`
- `apps/desktop/src/components/ChatTranscript.tsx`
