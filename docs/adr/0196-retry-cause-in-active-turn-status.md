# ADR 0196: Show provider retry causes in the active-turn status

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0175, D358, US-UI-60d
- Note: first filed as ADR 0186, then ADR 0195.

## Context

The live `retrying` status row says a provider request is being retried but not
why, even though the classified cause already becomes a structured assistant
error once the retry budget is exhausted. Users should be able to inspect the
cause during backoff without a duplicate transcript error.

## Decision

The shared `AgentActivity.retrying` payload gains optional bounded error details:
the stable error code, the already-redacted and length-limited provider message,
and the HTTP status when known, supplied for request-setup and mid-stream retries.
The renderer keeps the compact retry row at rest and reveals an error-styled
tooltip from a keyboard-focusable trigger that reuses the assistant error card's
hierarchy, closing when the activity phase clears.

## Consequences

- Users can identify rate limits, timeouts, network failures, and provider
  errors while waiting, with retry behavior unchanged.
- Only diagnostics the runtime already classified and redacted cross the
  protocol boundary.
- Older status payloads without `error` still render the ordinary retry label.

## Alternatives

- Use only a native `title`: rejected; it cannot match the error presentation or
  give consistent keyboard access.
- Add an assistant error row for every retry: rejected; a successful same-turn
  retry would look like a failed turn.
