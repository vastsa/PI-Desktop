# ADR: Runtime-owned first-output latency

- Status: Accepted
- Date: 2026-09-15
- Related: ADR 0073, ADR 0242, ADR `live-turn-throughput-estimate`

## Decision

The parent agent runtime measures one logical model request from entering its
stream function until the first non-empty text or visible thinking output.
It uses a monotonic clock, not renderer mount time or the assistant start event.
Transport retries inside the same stream are included; a subsequent logical
request (including a tool-loop continuation or runtime recovery) resets the
anchor. Retained content from a previous recovery attempt is not first output.
A tool-call-only response has no visible first-output metric. The number is
client-observed latency, including transport and queuing, not server-only TTFT.

An optional nonnegative integer `UiMessage.timeToFirstTokenMs` carries the
measurement through the constant-size delta identity and completed snapshot.
Rust stores it in existing message metadata alongside response duration.
As in ADR 0073, this is an additive optional JSON field: neither table layout
nor schema/protocol version changes, no migration is needed, and older records
omit the readout. No historical timing is inferred from transcript timestamps.

The active and completed meta rows show seconds to one decimal place. A logical
turn with several model calls displays the latest assistant message's value,
never a sum or average. Subagent-native timing is outside this initial scope.
Existing TPS sampling and provider diagnostic timing keep their meaning.

## Validation

Timer, runtime event, delta-coalescing, and durable metadata round-trip tests;
E2E-CHAT-first-output-latency plus transcript and protocol smoke suites after
main integration. A label without a measured value stays absent.
