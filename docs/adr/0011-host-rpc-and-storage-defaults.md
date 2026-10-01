# ADR 0011: Freeze host RPC, storage ownership, and mode defaults

- Status: Accepted; mode-profile clause superseded in part by ADR 0053;
  permission-timeout clause amended by ADR 0310
- Date: 2026-07-25

## Context

After baseline 0.3.0, implementation still depended on several high-impact defaults:

- Electron ↔ Rust transport
- SQLite ownership
- default interaction mode
- former restricted-profile tool split (superseded by ADR 0053)
- local permission approval behavior

## Decision

Freeze the following defaults for implementation:

1. Transport = **Rust sidecar + stdio JSON-RPC (NDJSON)**
2. SQLite ownership = **Rust host-core only**
3. Default mode = **Agent**
4. The former restricted profile was read-only; this mode-profile clause is
   superseded by ADR 0053, which supersedes the historical operating-state
   decision in ADR 0052 and replaces it with the current Plan workflow
5. Local permission approvals have **no automatic deadline**; they remain
   pending until an explicit decision, cancellation, or host/process shutdown
6. Session grants = **by toolName**
7. First release platform = **macOS arm64 only**
8. TS schema = **typebox**
9. i18n = **i18next**

## Consequences

### Positive
- M1/M2 can proceed without re-litigating core choices
- Clear process and data ownership
- Explicit host-owned operating-state and permission policy

### Negative
- JSON-RPC text protocol may later need binary upgrade
- Exclusive Rust DB ownership requires mature host RPC coverage early

## Related docs

- `docs/spec/08-meta/decisions-log.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/03-runtime/07-process-model.md`
- `docs/spec/04-ux/03-permission-ux.md`
