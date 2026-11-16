# ADR 0250 — Structured, bounded, and redacted process logs

- **Status**: Accepted for implementation
- **Date**: 2026-09-14
- **Amends**: [ADR 0046](0046-categorized-process-logs.md) · [ADR 0212](0212-remove-diagnostic-timing-log-streams.md)
- **Related**: [Logging and observability](../spec/03-runtime/09-logging-and-observability.md)

## Context

The categorized logger removed the old aggregate and timing streams, but its
remaining records were still too dependent on free-form messages. In particular,
a normal tool call produced separate `tool start` and `tool end` rows while
console mirroring discarded most correlation fields.

## Decision

1. Every process log record has a stable dot-separated `event` in addition to
   its short human-readable `message`.
2. A normal tool execution emits one `tool.execution.completed` or
   `tool.execution.failed` record after `tool_end`.
3. The Electron logger redacts sensitive object keys, authorization schemes, URL
   credentials, and common provider token formats.
4. Tool results are represented by safe summaries: outcome, stable error/code
   fields, duration, field names, content-block count, and stdout/stderr sizes.
5. Child stderr is emitted as a bounded, ANSI-free `data.output` value with the
   stable `child.process.stderr` event.

## Consequences

- Normal tool-loop storage and console noise are reduced without losing the
  final outcome, identifiers, error code, or duration needed for diagnosis.
- Logs are searchable by event and correlation ID and can be joined across app,
  host, and agent channels without parsing message text.
- Sensitive or unusually large diagnostic values are removed, summarized, or
  truncated before writing.
- Existing protocol, transcript, audit timing fields, retention, category files,
  and historical log files remain compatible.

## Alternatives

- **Keep start/end records and improve their wording.** Rejected because it
  preserves duplicate storage and still leaves the outcome split across rows.
- **Log complete tool arguments and results behind a debug switch.** Rejected
  because local debug logs are still user data and can contain credentials or
  private workspace content.
- **Add a separate timing stream for duration.** Rejected by ADR 0212; duration
  is retained only as functional metadata on the relevant outcome or audit
  record.
