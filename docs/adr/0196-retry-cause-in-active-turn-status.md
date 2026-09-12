# ADR 0196: Show provider retry causes in the active-turn status

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0175, D358, US-UI-60d
- Note: First filed as ADR 0186, then 0195; 0186 is session titles and 0195 is the work-panel toggle.

## Context

The live `retrying` status row tells users that a provider request is being
retried, but not why. The same classified provider failures already become
structured assistant errors when the retry budget is exhausted. During the
backoff, users should be able to inspect the current cause without creating a
duplicate transcript error or waiting for the retry to finish.

## Decision

Extend the shared `AgentActivity.retrying` payload with optional bounded error
details: the stable error code, the already-redacted and length-limited provider
message, and the HTTP status when known. The runtime supplies the details for
both request-setup and mid-stream retries.

The renderer keeps the existing compact retry row at rest. Hovering or focusing
its retry label reveals a small error-styled tooltip that reuses the assistant
error card's hierarchy: icon, localized summary, stable code/status, and the
provider message. The trigger is keyboard-focusable and exposes the same reason
through its accessible name. The tooltip closes when the activity phase clears;
the final assistant error and outcome surfaces remain the only terminal error
presentation.

## Consequences

- Users can identify rate limits, timeouts, network failures, and provider
  errors during a retry wait.
- The transcript remains free of intermediate error rows and retry behavior is
  unchanged.
- The protocol exposes only diagnostics already classified and redacted by the
  runtime; arbitrary provider payloads do not cross the boundary.
- Older status payloads without `error` continue to render the ordinary retry
  label.

## Alternatives

### Use only a native `title`

Rejected because it cannot match the existing error presentation, is difficult
to read for long provider messages, and provides inconsistent keyboard access.

### Add an assistant error row for every retry

Rejected because intermediate failures would duplicate the final assistant
error and make a successful same-turn retry look like a failed turn.

### Expose the full provider response

Rejected because provider responses can contain unstable or sensitive data. The
existing classifier's bounded message and low-cardinality status are sufficient
for diagnosis.
