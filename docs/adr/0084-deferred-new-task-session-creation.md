# ADR 0084: Defer new-task session creation until the first message

- Status: Accepted
- Date: 2026-08-14
- Related: D088, D093, D220

## Context

New Task created a session immediately, so sidebar history gained a
default-titled `新建任务` / "New task" row even when nothing was typed. The reuse
rule (D088/D093) kept at most one empty draft per project or temporary scope, but
that row was visible at once and the draft also persisted in the host database.

## Decision

New Task opens an unpersisted draft instead of creating a session: `newSession()`
resets the renderer to the home empty state, keeping the requested project scope,
leaving `activeSessionId` unset, and no longer calling `session.create` or
reusing a legacy empty draft. The first message, or a pasted file, materializes
the draft through a shared `materializeDraftSession` helper that applies retained
toolbar configuration from a `draftConfiguration` store slice before committing
the same navigation and run state the eager path used. The sidebar history filter
drops sessions whose title is still a default untitled value, hiding legacy empty
drafts as defense in depth.

## Consequences

- History only records tasks that carry input, and no new empty sessions
  accumulate in the host database.
- Only the renderer store, Composer, and Sidebar change; host RPC and the storage
  schema are untouched, so older renderers stay compatible.

## Alternatives

- Hide empty drafts but keep eager creation: leaves invisible sessions on disk.
- Create the session on the first keystroke: still creates rows for unsent text.
