# ADR 0084: Defer new-task session creation until the first message

- **Status:** Accepted
- **Date:** 2026-08-14
- **Related:** D220 · D088 · D093 · E2E-011b · E2E-011d · #746

## Context

Clicking New Task created a session immediately, so the sidebar history gained
a default-titled `新建任务` / "New task" row even when the user never typed a
message. A reuse rule (D088/D093) kept at most one empty draft per project or
temporary scope, but the first empty row still appeared and remained visible
until the user sent a prompt that renamed it. Empty draft sessions also left
rows on disk in the host database.

## Decision

New Task opens an unpersisted draft instead of creating a session:

- `newSession()` resets the renderer to the home empty state (keeping the
  requested project scope) and no longer calls `session.create` nor reuses a
  legacy empty draft. `activeSessionId` stays unset, which the renderer
  already supports as its initial and project-switching state.
- The first message (`sendPrompt`) or pasted files (which must attach to a
  session) materialize the draft through a shared `materializeDraftSession`
  helper that creates the session, applies any retained toolbar configuration,
  and commits the same navigation/run state the eager path used.
- Composer and top-bar model toolbar choices made on the draft are retained in
  a new `draftConfiguration` store slice and applied at materialization time
  instead of materializing a session on a toolbar-only interaction.
- The sidebar history filter now drops sessions whose title is still a default
  untitled value, hiding legacy empty drafts and any accidentally empty
  session as a defense in depth.

## Consequences

- The sidebar history only records tasks that actually carry input; abandoned
  New Task drafts leave no row and no persisted session.
- No new empty sessions accumulate in the host database; legacy empty drafts
  remain on disk but are hidden from history.
- The renderer store, Composer, and Sidebar change; protocol v9, host RPC, and
  storage schema v11 are untouched, so older renderers remain compatible.

## Alternatives considered

- Keep eager creation and only hide empty drafts in the sidebar: smaller
  change, but leaves invisible sessions on disk and keeps the reuse machinery
  alive for rows the user should never see.
- Create the session on the first draft keystroke: would still create rows for
  messages that are never sent, which is what the request asks to avoid.
