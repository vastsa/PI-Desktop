# ADR 0050: Bounded provider stream recovery and diagnostics

- Status: Accepted (amended by D259 and D378, see below)
- Date: 2026-08-04

## Amendment (D259, 2026-09)

Decision D259 supersedes the retry arithmetic in points 2 and 3 of this ADR. The
"one provider-level retry" during request setup and the "retry once after a 750
ms backoff" after a stream has started were replaced by one shared, bounded
budget for non-429 transient failures: four retries after the initial attempt
(five provider attempts in total), drawn from the same pool whether the failure
lands during request setup or mid-stream, with a deterministic 1 s / 2 s / 4 s /
8 s schedule capped at 8 s and `retry-after` headers honoured first.

## Context

The provider retry layer covers failures while establishing a request, but a
provider can also terminate after the assistant stream has started. The previous
runtime classified the common `terminated` message as a generic
`PROVIDER_ERROR`, ended the turn, and left regenerate to create a new runtime
and reseed the transcript.

## Decision

PI-Desktop applies the following bounded recovery strategy:

1. Classify `terminated`, premature stream closure, and equivalent incomplete
   stream messages as retryable `STREAM_FAILED` errors.
2. Configure pi-ai request setup with one provider-level retry and an
   interruptible delay capped at 8 seconds.
3. When a transient `STREAM_FAILED`, `NETWORK_ERROR`, or `TIMEOUT` occurs after
   a stream has started, retry once in the same turn after a 750 ms abortable
   backoff.
4. Attach `phase`, `providerWaitMs`, `streamMs`, provider status/code, and
   `retryAttempt` when available.
5. Mutation instructions select `Edit` for one small unique replacement and
   `Write` for a coherent whole-file rewrite.

## Consequences

- A single transient stream termination no longer forces regenerate or a new
  transcript/runtime boundary.
- The renderer sees one assistant bubble and one terminal lifecycle for a
  recovered turn.
- Provider errors remain diagnosable from agent timing and app session logs
  without exposing secrets.
- The retry budget is finite: persistent outages, authentication errors, context
  failures, and the second stream failure remain visible and actionable instead
  of entering an unbounded loop.
- Mutation recovery is deterministic and bounded.

## Alternatives

### Retry every provider error in the same turn

Rejected because authentication, model-selection, malformed-request, and context
errors are not fixed by replaying the same request.

### Retry stream failures indefinitely

Rejected because it hides persistent outages, consumes provider quota, and
prevents the user from regaining control of the session.

### Create a new assistant bubble for every stream attempt

Rejected because partial and failed attempts would look like multiple answers
and would complicate durable transcript reconciliation.

### Keep patch repair entirely prompt-driven

Rejected because wording alone does not reliably bound a model's retry loop.

## References

- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- Decision D186
