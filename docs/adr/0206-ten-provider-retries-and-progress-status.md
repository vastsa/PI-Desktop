# ADR 0206: Extend provider retries and show bounded progress

- Status: Accepted
- Date: 2026-09-10
- Deciders: PI-Desktop core
- Related: D378, E2E-096, E2E-149, ADR 0091, ADR 0128, ADR 0196

## Context

### Amendment: successful response boundary (issue #699, 2026-09-20)

Desktop fault injection reproduced a long task stopping on its eleventh
independent network failure after ten successful recoveries and tool calls. The
budget previously survived successful model responses for the whole user turn.

### Amendment: opt-in infinite provider retry

The default ten-retry budgets remain unchanged. AppSettings may opt into
`infiniteProviderRetry`; the runtime then skips only the retry-count ceiling for
admitted network/transient provider failures in the main session and builtin
subagents.

## Decision

1. `PROVIDER_RATE_LIMITED` and the admitted non-429 transient provider errors
   each receive a shared budget of ten retries after the initial provider
   attempt.
2. `PROVIDER_RETRY_MAX_RETRIES` in `packages/shared` is the single budget
   constant used by the runtime and renderer.
3. Delay behavior is unchanged except that the non-429 schedule remains at its
   8-second cap for retries after the first four waits.
4. The active-turn retry status uses the current `retryDelayMs` and `since` to
   render a whole-second countdown and shows the shared budget, for example
   `Retrying in 0s · attempt 9/10`.
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
