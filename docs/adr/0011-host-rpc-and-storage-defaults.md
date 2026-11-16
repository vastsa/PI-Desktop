# ADR 0011: Freeze host RPC, storage ownership, and mode defaults

- Status: Accepted; mode-profile clause superseded in part by ADR 0053;
  permission-timeout clause amended by ADR 0310
- Date: 2026-07-25
- Related: `docs/spec/03-runtime/06-host-rpc-protocol.md`

## Context

Several high-impact defaults — the Electron↔Rust transport, SQLite ownership, the
default interaction mode, and how permission approvals end — were still open after
baseline 0.3.0, and each one fixes process and data ownership.

## Decision

Freeze: Rust sidecar over stdio JSON-RPC (NDJSON); SQLite owned by host-core alone;
Agent as the default mode; permission approvals without an automatic deadline;
session grants keyed by toolName; macOS arm64 first; typebox schemas; i18next. The
former restricted (read-only) profile clause is superseded by ADR 0053, which replaces
the operating-state decision of ADR 0052 with the current Plan workflow.

## Consequences

- Process and data ownership stays unambiguous.
- Exclusive Rust database ownership requires host RPC coverage early.
- The text JSON-RPC protocol may later need a binary upgrade.
