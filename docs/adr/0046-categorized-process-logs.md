# ADR 0046: Categorized process log files

- Status: Accepted
- Date: 2026-08-02
- Related: [D082](../spec/08-meta/decisions-log.md) ·
  [D182](../spec/08-meta/decisions-log.md) ·
  [D183](../spec/08-meta/decisions-log.md) ·
  [Logging and observability](../spec/03-runtime/09-logging-and-observability.md)

## Context

The M5 logger reduced unbounded growth by keeping app, host, and agent output
in three rotating files. In practice, normal session activity, tool timing,
provider diagnostics, and lifecycle noise still accumulated in the same file,
which made a single failure expensive to trace. Child-process stderr also
arrived in arbitrary chunks and Rust tracing colors were persisted as escape
sequences.

## Decision

1. Keep `app`, `host`, and `agent` as the top-level local log channels, but
   write each channel to a directory of focused category files:
   `logs/<channel>/<category>.log`.
2. Main-process call sites declare an explicit category. Host and agent stderr
   uses marker-based classification; timing records always use `timing`, and
   unknown output uses `runtime`.
3. Add the category to every NDJSON record. The logger buffers child stderr by
   line, decodes UTF-8 at the stream boundary, and strips ANSI control
   sequences before writing.
4. Apply the existing 5 MB / two rotated files policy independently to every
   category file. Rotation and disk failures remain non-fatal. Existing flat
   files are not deleted automatically.

## Consequences

- A diagnostic investigation can open only the relevant session, tool,
  timing, provider, or lifecycle stream instead of scanning a mixed file.
- Timing records remain easy to grep at stable paths:
  `host/timing.log` and `agent/timing.log`.
- The logs folder contains more files, but each file has a bounded size and a
  stable purpose. The app still exposes the same folder-opening action.
- Older `app.log`, `host.log`, and `agent.log` files remain readable as legacy
  history, but new records are written only to the categorized layout.

## Alternatives rejected

- **Keep one file per channel and rely on the `category` field:** preserves
  the scan problem that motivated this change.
- **Create one file per session:** produces unbounded file counts and leaves
  boot, provider, and process failures without a natural session owner.
- **Delete or migrate legacy files on startup:** risks losing diagnostic
  history and makes a logging improvement capable of failing application boot.
