# ADR 0044: Session-bound project instruction preflight

- Status: Accepted
- Date: 2026-08-02
- Related: [ADR 0037](0037-project-instruction-chain.md)

## Context

Path-scoped instruction loading ran before every file tool. Its resolver lived in
Electron main but first called host-core `session.get` to rediscover the project
root, so a slow or congested host delayed an otherwise local file operation inside
the generic host round-trip measurement.

## Decision

Electron main derives the project root from the host-owned session record at runtime
launch and registers it on the sidecar wrapper before each prompt or compaction
request. A reverse `project.instructions.resolve` request uses that binding and
ignores any root supplied by sidecar payload. The sidecar keeps a per-prompt claim
map keyed by the registered root and target directory, reuses both successful
results and the best-effort fallback for later tools in the same prompt, and clears
the map before the next prompt so edits stay visible across messages. Tool timing
reports preflight separately from `hostRttMs`.

## Consequences

- Preflight no longer adds a `session.get` round trip, and repeated tools in one
  directory skip duplicate resolver IPC.
- The ADR 0037 boundary holds: the sidecar picks only the target path.
- A resolver timeout still falls back to the base chain without borrowing a sibling
  directory's instructions.
