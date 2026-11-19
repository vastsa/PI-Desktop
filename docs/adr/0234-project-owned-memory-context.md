# ADR 0234: Keep project memory host-owned and path-scoped

- Status: Accepted
- Date: 2026-09-12

## Context

Projects need a durable memory surface similar to ChatGPT Projects, and renderer
preferences cannot own model context: they are presentation state and give no
host-enforced boundary when a session switches projects.

## Decision

Store one user-authored memory collection per canonical project path in the host `kv`
table under the `projectMemory` namespace, with normalized `entries-v1` entries and a
host-derived plain-text `content` projection. Electron main loads the value for the
session-bound project path, and the runtime renders it after project instructions as
explicitly user-provided context and compares it when deciding whether an idle
runtime can be reused.

## Consequences

- Memory survives renderer restarts and is isolated by canonical project path, with
  legacy `content`-only records readable as one untitled entry.
- Changing memory retires the next reusable runtime so a follow-up prompt sees the
  new value.
- No migration is needed, and ADR 0249's project-group identity leaves path-scoped
  records as the compatibility behavior.

## Alternatives

- Keep memory in renderer preferences — rejected: presentation state cannot be the
  host-enforced boundary.
