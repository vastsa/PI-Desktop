# ADR 0236: Restore Archived Projects When Session Import Adds a Bound Session

- Status: Accepted
- Date: 2026-09-12
- Deciders: PI-Desktop maintainers

## Context

Project archive state belongs to renderer-local sidebar presentation metadata,
while session import is completed by the host. A successful import can create
or reuse a durable project and bind the new session to it without changing the
renderer metadata. The session then exists in the host index but its project
remains hidden from the default sidebar, making the import appear to have
failed (issue #250).

## Decision

- Core and plugin imports use an explicit import-refresh option when the
  renderer refreshes its session list.
- The renderer compares session ids before and after that refresh, collects
  normalized project paths for newly added project-bound sessions, and restores
  only matching project metadata that is currently archived.
- Pathless sessions, skipped imports, historical plugin project paths without
  an active project binding, and ordinary session refreshes do not change
  archive state.
- The host project model, IPC channel names, plugin SDK methods, storage schema,
  and persisted session/project data formats remain unchanged.

## Consequences

An imported session is immediately discoverable in the default project view,
including when a plugin uses an explicit host project id. Users can still keep
unrelated archived projects hidden, and a restart does not turn every archived
project with an old session into an active project.

## Alternatives considered

- **Add an archived column to host projects:** rejected because archive is a
  renderer presentation preference and the storage change would widen the
  persistence and migration surface.
- **Show archived projects whenever sessions refresh:** rejected because a
  normal refresh would silently undo deliberate archive choices.
- **Return an import error for archived projects:** rejected because importing
  into an existing project is valid and the user has already expressed intent
  to use that project.
