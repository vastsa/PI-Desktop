# ADR 0154: Reveal the New Task empty destination before host IO

- Status: Accepted
- Date: 2026-09-05
- Related: D252, D305, ADR 0113, ADR 0137, E2E-011a, E2E-011d, E2E-011g

## Context

ADR 0113 made New Task persist a durable empty session or reuse the group's latest
empty row, and the renderer awaited `session.list`, `session.create`, another
`session.list`, and `session.get` before changing the transcript. The previous
conversation therefore stayed on screen: the cold-switch rule of ADR 0137 fits
opening an existing session but read as a dead click for a new empty destination.

## Decision

Creating a session clears the previous transcript and retained panes synchronously
before `session.create`, so the empty home composer is the destination on the first
frame, and reusing an empty slot commits an empty transcript without waiting for
`session.get`. New Task decides reuse from the in-memory session list plus renderer
signals (`runningSessions`, live or cached rows, submitted drafts), while host
`messageCount` stays the durable empty predicate. The summary returned by
`session.create` is inserted into the sidebar list and no follow-up list or get runs
for a new empty session. One in-flight create is shared per group, so Send and paste
await the same promise. Protocol, storage, and host RPC are unchanged.

## Consequences

- New Task no longer leaves the previous conversation on screen, and rapid clicks or
  a first-message race stay serialized per group.
- An empty reuse still revalidates through `selectSession` once the empty pane is
  visible; D305 amends D252's refresh-then-select timing, not the reuse rule.
- The change is renderer-side only: `session.create` still owns the durable id.
