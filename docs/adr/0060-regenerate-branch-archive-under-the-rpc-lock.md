# ADR 0060: Archive the Regenerate Branch Under the RPC Lock

- Status: Accepted
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Related: D119 (transcript file store), D109 (regenerate history pager),
  ADR 0041 (decoupled message persistence)

## Context

Turn completion in Electron main archived the finished regenerate branch with a
read-modify-write across four host calls: `session.get`, `session.listRevisions`,
`session.saveRevision`, then `session.replaceMessages` to stamp pager metadata
(`revisionRootId` / `revisionCount` / `activeRevision`) on the user root.

Assistant and tool messages do not take that path. They travel through the
app-owned `PersistenceOutbox` (ADR 0041) and reach SQLite asynchronously through
`session.appendMessage`. The two paths therefore race, and `session.get` can
observe a transcript that is one message short of the turn it is archiving.

`session.replaceMessages` is a whole-transcript rewrite: it deletes every index
row for the session and rewrites the transcript file from the caller's array. A
snapshot taken before the outbox drained is written back as the truth, so the
message appended in between is deleted from both the transcript file and the
index. One observed session lost its final assistant message exactly this way —
the model call succeeded (`outcome=ok`, `providerStatus=200`), the append
succeeded, and the stamp-only rewrite landed 62 ms later from a stale snapshot.
The rewrite also dropped `turn_id` on every row, because the reinserted index
rows carried no turn attribution.

The metadata being written was a no-op in that case: the root already carried
the intended `revisionCount` / `activeRevision`. A rewrite whose only purpose is
an idempotent stamp destroyed a message.

## Decision

1. Turn completion calls one new host method, `session.saveActiveRevision`,
   which performs read, archive, and stamp inside a single RPC while holding the
   host state lock. No transcript snapshot crosses a process boundary and no
   window exists for a concurrent `session.appendMessage` to be overwritten.
2. The pager stamp rewrites exactly one transcript line
   (`transcripts::update_message`), copying every other line through verbatim.
   The file is re-read inside that function, so a line appended after any
   caller's own read survives. A metadata stamp can no longer cost the
   transcript its newest messages.
3. Electron main drains the persistence outbox before calling, and skips the
   archive (with a warning) when the outbox cannot be drained. An incomplete
   branch archive is silently wrong forever once a user pages back to it, so
   not archiving is the better failure.
4. `session.replaceMessages` keeps each surviving message's owning `turn_id`
   across the rewrite. Remaining callers (regenerate truncation, tool review
   state) no longer strip turn attribution from the index.
5. `session.replaceMessages` is documented as safe only for a caller that owns
   the whole transcript for the duration of the call. Read-modify-write over it
   from Electron main is not a supported pattern.
6. The new method is additive and the protocol version stays at 9. Host and
   Electron ship in one artifact, and a host without the method fails the call,
   which the caller already logs as a skipped archive rather than treating as
   data loss. Nothing a v9 client relies on changes.

## Quit-time lifecycle correction (2026-10-07)

An archive can outlive `activeTurns` and an empty append outbox. Previously,
quitting in that interval disposed host-core while `session.saveActiveRevision`
was pending. Electron now tracks terminal event writes, stops sidecar event
production, and drains those writes before host disposal. The drain is bounded
using the existing two-second quit budget and warns if the host remains
unresponsive. This preserves the single-RPC archival contract without adding a
second archive path or changing stored transcript formats.

## Alternatives considered

- **Await the outbox and keep the four-call rewrite:** narrows the window but
  does not close it. Any future writer on the append path reopens it, and the
  destructive primitive stays in the turn-completion path. Rejected.
- **Stamp through a targeted `session.updateMessage` RPC and keep the archive
  in Electron:** still two host calls with the archive reading a snapshot from
  outside the lock, so the archived branch can miss the final message even
  though the live transcript survives. Rejected.
- **Make `session.replaceMessages` merge unknown newer messages:** an implicit
  merge in a method whose contract is "this is the transcript" would make
  regenerate truncation unable to delete anything. Rejected.
- **Bump the protocol version to 10:** buys no negotiation because handshake
  already requires exact equality between components that ship together, and
  forces edits to five unrelated frozen-contract guards. Rejected.

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
