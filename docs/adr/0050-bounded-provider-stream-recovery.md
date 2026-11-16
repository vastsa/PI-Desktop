# ADR 0050: Bounded provider stream recovery and diagnostics

- Status: Accepted (amended by D259 and D378 / ADR 0206, which replaced the retry
  arithmetic below with one shared bounded budget; classification per D186)
- Date: 2026-08-04

## Context

The provider retry layer covered failures while establishing a request, but a
provider can also terminate after the assistant stream has started: the runtime
classified the common `terminated` message as a generic `PROVIDER_ERROR`, ended
the turn, and left regenerate to build a new runtime and reseed the transcript.
Repeated mutation failures had a related cost, as the model could keep repairing
an obsolete patch instead of taking a fresh snapshot of the target file.

## Decision

1. Classify `terminated`, premature stream closure, and equivalent incomplete
   stream messages as retryable `STREAM_FAILED`, preserving only safe,
   low-cardinality provider status/code fields in `AppError.details`.
2. Configure pi-ai request setup with a provider-level retry and an interruptible
   delay, forwarding the durable session id for adapters with request affinity.
3. After a stream has started, retry transient `STREAM_FAILED`, `NETWORK_ERROR`,
   or `TIMEOUT` in the same turn after an abortable backoff: the failed assistant
   leaves the next model context with its visible message id reused, so partial
   content is replaced rather than duplicated; a further failure is terminal.
4. Attach `phase`, `providerWaitMs`, `streamMs`, provider status/code, and
   `retryAttempt` as diagnostics only — redacted, bounded, and never carrying
   credentials or raw provider bodies.
5. Mutation instructions select `Edit` for one small unique replacement and
   `Write` for a coherent whole-file rewrite; after a mismatch the agent follows
   the line-anchored contract's fresh-read or complete-reveal recovery, and the
   third counted failed `Edit` or shell patch command returns pi-agent-core's
   terminating tool hint with the exact mismatch.

## Consequences

- One transient stream termination no longer forces regenerate or a new
  transcript/runtime boundary; a recovered turn keeps one assistant bubble and
  one terminal lifecycle.
- Provider errors stay diagnosable from agent timing and session logs without
  exposing secrets.
- Persistent outages, authentication errors, context failures, and repeated
  stream failures stay visible and actionable instead of looping.

## Alternatives

- Retry every provider error in the same turn: authentication, model-selection,
  and context errors are not fixed by replaying the request.
- Create a new assistant bubble per attempt: partial attempts would look like
  multiple answers and complicate transcript reconciliation.
