# ADR 0050: Bounded provider stream recovery and diagnostics

- Status: Accepted (amended by D259 and D378, see below)
- Date: 2026-08-04

## Amendment (D259, 2026-09)

Decision D259 supersedes the retry arithmetic in points 2 and 3 of this ADR.
The "one provider-level retry" during request setup and the "retry once after
a 750 ms backoff" after a stream has started were replaced by one shared,
bounded budget for non-429 transient failures: four retries after the initial
attempt (five provider attempts in total), drawn from the same pool whether
the failure lands during request setup or mid-stream, with a deterministic
1 s / 2 s / 4 s / 8 s schedule capped at 8 s and `retry-after` headers honoured
first. `PROVIDER_ERROR` joined `STREAM_FAILED`, `NETWORK_ERROR`, and
`TIMEOUT` in the retriable set. The constants live in
`packages/agent-runtime/src/provider-retry.ts`
(`PROVIDER_TRANSIENT_MAX_RETRIES`, `PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS`,
`PROVIDER_SETUP_MAX_RETRY_DELAY_MS`). The 429 rate-limit budget stays separate.
Decision D378 (ADR 0206, 2026-09-10) then raised both budgets to ten retries
after the initial attempt, shared as `PROVIDER_RETRY_MAX_RETRIES`, while
keeping the 1 s / 2 s / 4 s schedule and its 8 s cap for non-429 waits.
Everything else in this ADR (classification, single visible bubble,
diagnostics, mutation recovery) still stands. The original text below is kept
as written for the record.

## Context

The provider retry layer covers failures while establishing a request, but a
provider can also terminate after the assistant stream has started. The
previous runtime classified the common `terminated` message as a generic
`PROVIDER_ERROR`, ended the turn, and left regenerate to create a new runtime
and reseed the transcript. This made transient stream failures expensive and
made a long provider wait difficult to attribute from logs.

Repeated mutation failures had a related cost: the model could keep repairing
an obsolete patch or retrying an `Edit` with stale context instead of taking a
fresh snapshot of the target file.

## Decision

PI-Desktop applies the following bounded recovery strategy:

1. Classify `terminated`, premature stream closure, and equivalent incomplete
   stream messages as retryable `STREAM_FAILED` errors. Preserve only safe,
   low-cardinality provider status/code fields in `AppError.details`.
2. Configure pi-ai request setup with one provider-level retry and an
   interruptible delay capped at 8 seconds. Forward the durable session id so
   provider adapters that support request affinity can reuse it.
3. When a transient `STREAM_FAILED`, `NETWORK_ERROR`, or `TIMEOUT` occurs
   after a stream has started, retry once in the same turn after a 750 ms
   abortable backoff. Remove the failed assistant from the next model context,
   reuse its visible assistant message id, and replace the partial content
   instead of creating a duplicate bubble. A second failure is terminal.
4. Attach `phase`, `providerWaitMs`, `streamMs`, provider status/code, and
   `retryAttempt` when available. These fields are diagnostic only; messages
   remain redacted and bounded and never contain credentials or raw provider
   bodies beyond the existing capped summary.
5. Mutation instructions select `Edit` for one small unique replacement and
   `Write` for a coherent whole-file rewrite. After an edit mismatch, the agent
   follows the line-anchored contract's fresh-read or complete-reveal recovery
   and may have three counted failures per path in one prompt. The third counted
   failed `Edit`, or the third failed shell patch command, returns pi-agent-core's
   terminating tool hint, so the agent stops with the exact mismatch. Shell
   `apply_patch`, `git apply`, and `patch` are explicitly treated as patch
   commands; the prompt directs the agent to use `Edit` or `Write` instead. It
   must not hand-edit unified-diff artifacts or issue concurrent mutations for
   one path.

## Consequences

- A single transient stream termination no longer forces regenerate or a new
  transcript/runtime boundary.
- The renderer sees one assistant bubble and one terminal lifecycle for a
  recovered turn.
- Provider errors remain diagnosable from agent timing and app session logs
  without exposing secrets.
- The retry budget is finite: persistent outages, authentication errors,
  context failures, and the second stream failure remain visible and
  actionable instead of entering an unbounded loop.
- Mutation recovery is deterministic and bounded. A genuinely stale file or
  invalid shell patch requires a new user/model decision after the second
  failure rather than another automatic tool turn.

## Alternatives

### Retry every provider error in the same turn

Rejected because authentication, model-selection, malformed-request, and
context errors are not fixed by replaying the same request.

### Retry stream failures indefinitely

Rejected because it hides persistent outages, consumes provider quota, and
prevents the user from regaining control of the session.

### Create a new assistant bubble for every stream attempt

Rejected because partial and failed attempts would look like multiple answers
and would complicate durable transcript reconciliation.

### Keep patch repair entirely prompt-driven

Rejected because wording alone does not reliably bound a model's retry loop.
The host's unique-context checks and per-session mutation serialization remain
the execution boundary, while the runtime's terminating tool hint enforces the
second Edit or shell-patch failure stop in pi-agent-core.

## References

- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- Decision D186
