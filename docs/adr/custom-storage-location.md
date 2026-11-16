# ADR: Custom storage location with cold migration

- Status: Accepted
- Date: 2026-10-01
- Related: issue #1213, ADR 0011, ADR 0094

## Context

Application data and Chromium browser and plugin state accumulate on the default
system volume, and moving only the host root strands browser state and absolute
attachment and plugin references, while copying a live database or profile risks
inconsistent snapshots and late writes.

## Decision

Use explicit settings confirmation followed by the existing ordered shutdown,
journal pending work in the original Electron `userData` directory, which stays
the installation identity and single-instance lock, and show cold migration
progress in a sandboxed nonpersistent window before any writer boots. An empty
selected destination owns `data/` and `browser/`: the filesystem service copies
every profile file, preserves links and permissions, verifies bytes, and records
ownership for retry, then Rust alone rewrites known host-owned structured paths
and the copied SQLite index offline without schema upgrades or startup recovery.
The durable pointer is published atomically afterwards, normal startup sets
Chromium `sessionData` before ready, and the selected root reaches every
existing service. Source profiles stay as visible backups behind a separate
confirmed cleanup action.

## Consequences

- Migration needs room for one verified copy plus metadata, and source data is
  untouched when copying fails.
- A missing custom volume blocks startup with a recovery message rather than
  creating a misleading empty profile.
- Unknown plugin-private absolute references keep their bytes, and no schema,
  protocol, or plugin SDK change is required.

## Alternatives

- Live relocation: rejected, SQLite, plugin processes, browser partitions, and
  logs share no atomic live-switch boundary.
- Move `userData` and its lock: rejected, it changes installation identity and
  admits competing launches during migration.
