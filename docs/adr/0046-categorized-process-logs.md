# ADR 0046: Categorized process log files

- Status: Accepted; timing-specific clauses superseded by ADR 0212
- Date: 2026-08-02
- Related: D082, D182, D183, ADR 0212

## Context

The M5 logger bounded growth by splitting app, host, and agent output into three
rotating files, but session activity, tool timing, provider diagnostics, and
lifecycle noise still shared one file, so tracing a single failure meant scanning
everything. Child stderr also arrived in arbitrary chunks and Rust tracing colors
were persisted as escape sequences.

## Decision

Keep `app`, `host`, and `agent` as top-level channels but write each into
`logs/<channel>/<category>.log`, with main-process call sites declaring an
explicit category, host and agent stderr classified by marker, timing records
under `timing`, and unknown output under `runtime`. Every NDJSON record carries
the category, child stderr is buffered by line, UTF-8 is decoded at the stream
boundary, and ANSI is stripped before writing; the 5 MB / two rotated files
policy applies per category file, rotation and disk failures stay non-fatal, and
legacy flat files are left readable but receive no new records.

## Consequences

- Investigations open only the relevant stream, and timing records stay
  greppable at `host/timing.log` and `agent/timing.log`.
- The folder holds more, smaller single-purpose files.

## Alternatives

- One file per channel relying on the `category` field: keeps the scan problem.
- One file per session: unbounded counts, and boot, provider, and process
  failures have no session owner.
