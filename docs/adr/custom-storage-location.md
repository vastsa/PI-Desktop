# ADR: Custom storage location with cold migration

- Status: Accepted
- Date: 2026-10-01
- Related: issue #1213, ADR 0011, ADR 0094

## Context

Application data and Chromium's browser/plugin state accumulate on the default
system volume. Changing only the host root strands browser state and absolute
internal attachment/plugin references.

## Decision

Use explicit settings confirmation followed by existing ordered shutdown.
Journal pending work in the original Electron userData directory, which remains
the stable installation identity and single-instance lock.

An empty selected destination owns `data/` and `browser/`. The production Node
filesystem service copies all profile files, preserves links/permissions,
verifies SHA-256 bytes and records ownership for retry.

## Alternatives

- Live relocation: rejected because SQLite, plugin processes, browser
  partitions, outbox and logs do not share an atomic live-switch boundary.
- Cache-only relocation: does not satisfy the requested complete storage
  migration.
- Move userData and its lock: changes installation identity and admits competing
  launches while migrating.
- Rewrite every matching byte/string: would corrupt credentials, user commands,
  code, prose, Chromium databases and unknown plugin-owned formats.

## Consequences

The default profile and Rust ownership remain compatible.

Unknown plugin-private absolute references and historical narrative paths retain
their bytes; extension authors own their portability.
