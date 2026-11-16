# ADR 0236: Restore Archived Projects When Session Import Adds a Bound Session

- Status: Accepted
- Date: 2026-09-12

## Context

Project archive state lives in renderer-local sidebar metadata, while session
import completes in the host. An import can create or reuse a durable project and
bind a new session to it without touching that metadata, so the session exists but
its project stays hidden and the import looks failed (issue #250).

## Decision

Core and plugin imports refresh the session list with an explicit import flag. The
renderer compares session ids across that refresh, collects normalized paths of
newly added project-bound sessions, and un-archives only matching project
metadata. Pathless sessions, skipped imports, historical plugin paths without an
active binding, and ordinary refreshes never change archive state. The host
project model, IPC channels, plugin SDK, storage schema, and persisted formats are
unchanged.

## Consequences

- Imported sessions are immediately visible in the default project view.
- Unrelated archived projects stay hidden, including after restart.

## Alternatives

- Persist an archived column on host projects: rejected because archive is a
  renderer preference and the schema change would widen the migration surface.
- Un-archive on every session refresh: rejected because it silently undoes
  deliberate archive choices.
