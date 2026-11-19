# ADR 0250 — Structured, bounded, and redacted process logs

- Status: Accepted for implementation (amends ADR 0046, ADR 0212)
- Date: 2026-09-14

## Context

The categorized logger removed the aggregate and timing streams, but its records
leaned on free-form messages: a normal tool call produced separate start and end rows
and child stderr and error details could carry credentials, absolute local paths, or
unbounded diagnostic text.

## Decision

Every record carries a stable dot-separated `event` beside its short `message`, with
correlation fields (`traceId`, `requestId`, `sessionId`, `turnId`, `toolCallId`,
parent tool call, agent, plugin, and execution IDs) kept top-level, and a normal tool
execution emits one `tool.execution.completed`, `tool.execution.failed`, or
`tool.execution.interrupted` record while `tool_start`/`tool_end` protocol events and
transcript persistence stay unchanged. The Electron logger redacts sensitive object
keys, authorization schemes, URL credentials, and provider token formats, replaces
home, application-data, and log-directory prefixes with placeholders, and bounds
string length, depth, field counts, array items, and serialized `data`, with host-core
audit payloads receiving the same treatment. Tool results appear as safe summaries —
outcome, stable error and code fields, duration, field names, content-block count, and
stdout/stderr sizes — never raw arguments, file contents, command output, or plugin
responses, and child stderr is a bounded, ANSI-free `data.output` under
`child.process.stderr`. Console mirrors carry the same sanitized record, and
production mirrors only errors.

## Consequences

- Tool-loop storage and console noise drop without losing outcome, identifiers, error
  code, or duration, and records join across app, host, and agent channels.
- Sensitive or oversized values are removed, summarized, or truncated before writing,
  and logging stays best-effort.
- Existing protocol, transcript, timing fields, retention, category files, and
  historical logs remain compatible.

## Alternatives

- Keep start/end rows with better wording: keeps duplicate storage.
- Log full arguments behind a debug switch: debug logs are still user data.
