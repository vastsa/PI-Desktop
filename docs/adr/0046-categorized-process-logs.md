# ADR 0046: Categorized process log files

- Status: Accepted; timing-specific clauses superseded by ADR 0212
- Date: 2026-08-02
- Related: [D082](../spec/08-meta/decisions-log.md) ·
  [D182](../spec/08-meta/decisions-log.md) ·
  [D183](../spec/08-meta/decisions-log.md) ·
  [ADR 0212](0212-remove-diagnostic-timing-log-streams.md) ·
  [Logging and observability](../spec/03-runtime/09-logging-and-observability.md)

## Context

The M5 logger reduced unbounded growth by keeping app, host, and agent output in
three rotating files. In practice, normal session activity, tool timing,
provider diagnostics, and lifecycle noise still accumulated in the same file,
which made a single failure expensive to trace.

## Decision

1. Keep `app`, `host`, and `agent` as the top-level local log channels, but
   write each channel to a directory of focused category files:
   `logs/<channel>/<category>.log`.
2. Main-process call sites declare an explicit category.
3. Add the category to every NDJSON record.
4. Apply the existing 5 MB / two rotated files policy independently to every
   category file.

## Consequences

- A diagnostic investigation can open only the relevant session, tool, timing,
  provider, or lifecycle stream instead of scanning a mixed file.
- Timing records remain easy to grep at stable paths: `host/timing.log` and
  `agent/timing.log`.
- The logs folder contains more files, but each file has a bounded size and a
  stable purpose.
- Older `app.log`, `host.log`, and `agent.log` files remain readable as legacy
  history, but new records are written only to the categorized layout.

## Alternatives rejected

- **Keep one file per channel and rely on the `category` field:** preserves the
  scan problem that motivated this change.
- **Create one file per session:** produces unbounded file counts and leaves
  boot, provider, and process failures without a natural session owner.
- **Delete or migrate legacy files on startup:** risks losing diagnostic history
  and makes a logging improvement capable of failing application boot.
