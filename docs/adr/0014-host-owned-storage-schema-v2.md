# ADR 0014: Adopt host-owned storage schema v2

- Status: Accepted
- Date: 2026-07-26

## Context

The original desktop persistence model split durable state across a limited
SQLite schema and Electron-owned JSON files. Session messages stored a lossy
text projection, project identity was represented as a singleton workspace,
scheduled tasks bypassed the Rust host, and several product surfaces had no
durable model for turns, artifacts, task runs, model metadata, or indexed
search.

## Decision

Adopt schema v2 in the single host-owned `pi.sqlite` database.

The Rust host is the exclusive writer for:

- namespaced key/value configuration;
- projects and project-scoped sessions;
- canonical transcript blocks and turn lifecycle data;
- model catalog metadata;
- artifacts;
- scheduled tasks and task-run history;
- indexed, prunable audit events.

## Consequences

- Durable state has one ownership boundary and one migration mechanism.
- Transcript blocks, turns, usage, artifacts, project grouping, task history,
  and search can evolve without renderer-owned persistence.
- A migration failure is surfaced instead of silently opening a partially
  upgraded database.
- The backup consumes additional disk space until the user removes it.
- Protocol, storage, migration, and E2E specifications must move together with
  future structural changes.

## Alternatives

### Extend the v1 tables without rebuilding

Rejected because the v1 message shape is lossy and the split ownership model
would remain.

### Keep scheduled tasks in Electron JSON

Rejected because it violates the host-owned persistence boundary and prevents
atomic task/run lifecycle updates.

### Let the renderer write SQLite directly

Rejected because concurrent writers would couple UI lifecycle to data integrity
and bypass host RPC validation.

## References

- `docs/adr/0011-host-rpc-and-storage-defaults.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D086)
