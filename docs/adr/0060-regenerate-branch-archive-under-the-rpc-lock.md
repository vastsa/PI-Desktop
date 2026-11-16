# ADR 0060: Archive the Regenerate Branch Under the RPC Lock

- Status: Accepted
- Date: 2026-08-06
- Related: D119 (transcript file store), D109 (regenerate history pager),
  ADR 0041 (decoupled message persistence)

## Context

Turn completion in Electron main archived the finished regenerate branch with a
read-modify-write across `session.get`, `session.listRevisions`,
`session.saveRevision`, and `session.replaceMessages`, while assistant and tool
messages reached SQLite asynchronously through the app-owned
`PersistenceOutbox` (ADR 0041). The paths raced: a snapshot taken before the
outbox drained was rewritten as the truth, deleting the message appended in
between, and the rewrite also stripped `turn_id` from every reinserted index
row. An idempotent metadata stamp could therefore destroy a transcript message.

## Decision

### 1. One host call owns read, archive, and stamp

Turn completion calls `session.saveActiveRevision`, which performs all three
inside a single RPC while holding the host state lock, so no transcript snapshot
crosses a process boundary.

### 2. The stamp rewrites one line

The pager stamp updates exactly one transcript line through
`transcripts::update_message`, copying the other lines verbatim and re-reading
the file inside the call, so a line appended after the caller's read survives.

### 3. Archiving skips rather than runs on stale state

Electron main drains the persistence outbox first and skips the archive with a
warning when the drain fails, because an incomplete archived branch stays wrong
forever once a user pages back to it.

### 4. Transcript rewrites keep turn attribution

`session.replaceMessages` preserves each surviving message's owning `turn_id`,
and is documented as safe only for a caller that owns the whole transcript for
the duration of the call; read-modify-write from Electron main is unsupported.

### 5. The change is additive

The new method keeps the protocol at version 9: host and Electron ship in one
artifact, and a host without the method fails the call, which the caller already
logs as a skipped archive. A quit-time correction (2026-10-07) makes Electron
track terminal event writes and drain them within the existing quit budget
before host disposal, so a pending archive is not disposed mid-flight.

## Consequences

- A turn completing after a regenerate can no longer lose its final assistant
  message, and archived branches hold the whole turn.
- `turn_id` survives transcript rewrites, keeping per-turn queries accurate.
- Transcript logic shrinks in Electron main: root search, revision arithmetic,
  and stamping now live in host-core. Data lost before this change is not
  recoverable.

## Alternatives considered

- Await the outbox and keep the four-call rewrite: rejected; it narrows the
  window instead of closing it.
- Merge unknown newer messages inside `session.replaceMessages`: rejected; an
  implicit merge would stop regenerate truncation from deleting anything.
