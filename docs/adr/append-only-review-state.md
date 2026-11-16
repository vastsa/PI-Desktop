# ADR: Append-only review state

- Status: Implemented candidate
- Date: 2026-10-28
- Related: Issue #1836, ADR 0043, ADR 0060, ADR 0127

## Context

Rolling back one historical tool card loaded the complete session and called
`replace_messages` to persist `details.review.state`, rewriting the whole transcript
and rebuilding every SQLite message index row under the host state lock, although only
one small metadata value changed. Appending a replacement message instead would move
its physical position and break bounded history navigation.

## Decision

Append a distinct `tool_review_state` line keyed by message and snapshot ids, leaving
the original message line and every message-window coordinate unchanged. Full reads,
bounded reads, and tool-parent lookups replay the latest matching state, and those
offsets are indexed separately in layout-cache format 3. Cache reuse requires a
matching file identity and modification stamp, and only a host-owned append from the
proven generation advances an in-memory prefix without a rescan.

The owning tool snapshot is validated before appending, duplicate acknowledgements are
avoided, and the existing flush/fsync path provides durability before only the session
timestamp is updated. File order is the order of record, indexed reads sort offsets by
byte position, and the last appended state wins for the same message and snapshot.

### Rewrite and archive folding

Existing rewrite, fork, revision, and archive operations consume the effective message
projection, so state is folded into their payloads: the surviving tool's effective
state reaches its canonical message, discarded messages keep theirs in the archived
branch, and fork and revision activation serialize the combined prefix.

## Consequences

- A review update writes only its ids and state instead of retained history.
- The first mutation after a restart still runs the storage-integrity verification,
  and ordinary reads also read the small state log.
- The line type is additive to transcript format 2 with no database or RPC migration,
  so older readers skip it and may show stale card state.

## Alternatives

- Call `update_message` — rejected: it still copies all historical bytes for a
  non-tail message.
- Append the whole tool message — rejected: it creates a new physical position.
