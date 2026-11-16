# ADR 0044: Session-bound project instruction preflight

- Status: Accepted
- Date: 2026-08-02
- Related: [ADR 0037](0037-project-instruction-chain.md) ·
  [Agent runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [Logging](../spec/03-runtime/09-logging-and-observability.md)

## Context

Path-scoped instruction loading ran before every file tool. The resolver lived
in Electron main, but it first called host-core `session.get` to rediscover the
project root.

## Decision

1. Electron main derives the project root from the host-owned session record
   during runtime launch and passes it as launch metadata.
2. Electron main registers that root on the sidecar wrapper before each prompt
   or compaction request.
3. The sidecar keeps a per-prompt claim map keyed by the registered root and
   target directory.
4. Tool timing reports instruction preflight separately from `hostRttMs`, with
   cache-hit and base-fallback markers.

## Consequences

- File-tool preflight no longer adds a host-core `session.get` round trip.
- Repeated file tools in one directory avoid duplicate resolver IPC and file
  discovery while preserving cross-message freshness.
- The main-process containment boundary from ADR 0037 remains explicit: the
  sidecar selects only a target path, while Electron main owns the root.
- A resolver timeout or host failure remains best-effort and falls back to the
  base chain without carrying a sibling directory's instructions.

## Alternatives rejected

- **Cache instruction chains across all prompts:** risks stale rules after an
  instruction file changes and requires file-watch or stat invalidation.
- **Trust a project root sent by the sidecar:** weakens the session-bound
  containment boundary and lets model-directed input choose the scan root.
- **Keep the per-file `session.get`:** preserves an avoidable host dependency on
  the hottest file-tool preflight path.
