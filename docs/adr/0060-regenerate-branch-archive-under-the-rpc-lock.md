# ADR 0060: Archive the Regenerate Branch Under the RPC Lock

- Status: Accepted
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Related: D119 (transcript file store), D109 (regenerate history pager),
  ADR 0041 (decoupled message persistence)

## Context

Turn completion in Electron main archived the finished regenerate branch with a
read-modify-write across four host calls: `session.get`,
`session.listRevisions`, `session.saveRevision`, then `session.replaceMessages`
to stamp pager metadata (`revisionRootId` / `revisionCount` / `activeRevision`)
on the user root.

## Decision

1. Turn completion calls one new host method, `session.saveActiveRevision`,
   which performs read, archive, and stamp inside a single RPC while holding the
   host state lock.
2. The pager stamp rewrites exactly one transcript line
   (`transcripts::update_message`), copying every other line through verbatim.
3. Electron main drains the persistence outbox before calling, and skips the
   archive (with a warning) when the outbox cannot be drained.
4. `session.replaceMessages` keeps each surviving message's owning `turn_id`
   across the rewrite.
5. `session.replaceMessages` is documented as safe only for a caller that owns
   the whole transcript for the duration of the call.
6. The new method is additive and the protocol version stays at 9.

## Quit-time lifecycle correction (2026-10-07)

An archive can outlive `activeTurns` and an empty append outbox. Previously,
quitting in that interval disposed host-core while `session.saveActiveRevision`
was pending.

## Alternatives considered

- **Await the outbox and keep the four-call rewrite:** narrows the window but
  does not close it.
- **Stamp through a targeted `session.updateMessage` RPC and keep the archive in
  Electron:** still two host calls with the archive reading a snapshot from
  outside the lock, so the archived branch can miss the final message even
  though the live transcript survives.
- **Make `session.replaceMessages` merge unknown newer messages:** an implicit
  merge in a method whose contract is "this is the transcript" would make
  regenerate truncation unable to delete anything.
- **Bump the protocol version to 10:** buys no negotiation because handshake
  already requires exact equality between components that ship together, and
  forces edits to five unrelated frozen-contract guards.

## Consequences

- A turn that completes after a regenerate can no longer lose its final
  assistant message, and archived branches contain the whole turn.
- `turn_id` survives transcript rewrites, so per-turn queries and diagnostics
  stay accurate after regenerate and tool review updates.
- Electron main holds less transcript logic: the branch root search, the
  revision index arithmetic, and the stamp now live in host-core with unit
  tests, including one that appends a message after the archive's read.
- Data already lost to the previous behavior is not recoverable; the message is
  absent from both the rewritten transcript and the archived revision payload.
