# ADR 0014: Adopt host-owned storage schema v2

- Status: Accepted
- Date: 2026-07-26
- Related: ADR 0011, D086

## Context

Durable state was split between a limited SQLite schema and Electron-owned JSON
files: session messages kept a lossy text projection, project identity was a
singleton workspace, scheduled tasks bypassed the Rust host, and turns,
artifacts, task runs, model metadata, and indexed search had no durable model.
Those boundaries conflict with the host-ownership rule in ADR 0011 and make
protocol behavior depend on which process wrote last.

## Decision

Adopt schema v2 in the single host-owned `pi.sqlite` database. The Rust host is
the exclusive writer for namespaced configuration, projects and project-scoped
sessions, canonical transcript blocks and turn lifecycle, model catalog metadata,
artifacts, scheduled tasks with run history, and indexed prunable audit events.
Electron reaches that state only through host RPC, and imported scheduled-task
JSON stops being authoritative. Migrations are ordered Rust functions keyed by
`PRAGMA user_version`; the v1-to-v2 step takes a one-shot backup, preserves
recoverable data, and completes transactionally, with idempotent session, project,
and legacy task imports.

## Consequences

- Durable state has one ownership boundary and one migration mechanism.
- Transcripts, turns, usage, artifacts, grouping, task history, and search can
  evolve without renderer-owned persistence.
- A migration failure is surfaced instead of opening a partially upgraded
  database, at the cost of backup disk space until the user removes it.

## Alternatives

- Extend the v1 tables in place: rejected because the v1 message shape stays lossy
  and the split ownership remains.
- Let the renderer write SQLite: rejected because concurrent writers couple UI
  lifecycle to data integrity and bypass host RPC validation.
