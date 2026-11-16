# ADR 0265: Priority block and row actions for the Host-owned turn queue

- Status: Accepted for implementation
- Date: 2026-09-15
- Amends: ADR 0213 (persisted Host-owned turn queue), ADR 0118 (renderer-owned
  queued prompts and turn-boundary stops)

## Context

ADR 0213 moved the queue into host-core and gave "Send now" exactly one shape:
`prioritize` rewrites the entry's `position` below the current minimum, so the
entry jumps to the head of the whole queue. The renderer mirrored that as a
single in-memory `sendNowRequested` flag cleared on every other row, which meant
only one row could ever be waiting for the next boundary, and two "Send now"
clicks resolved as "the last click wins".

## Decision

1. **A promotion block, ordered by click.** `turn_queue` gains a nullable
   `priority` column (schema v18).
2. **Promotion is one-way and idempotent-hostile.** Promoting an entry that
   already carries a `priority` fails with `CONFLICT`/`ALREADY_PRIORITIZED`
   instead of silently moving it again.
3. **Promotion fixes order, but does not prevent cancellation.** A promoted row
   disables move up, move down, edit, and Send now.
4. **A reorder operation for the plain queue.** `session.queueReorder` swaps one
   entry's `position` with its adjacent non-prioritized neighbour in the
   requested direction, and reports `moved: false` for a missing entry, a
   promoted entry, or a block/queue edge.
5. **Edit returns the row to the composer.** Editing is renderer-local: the row
   is removed (through the existing removal path) and its captured
   `ComposerDraftSnapshot` — text plus inline file references — replaces the
   composer input through the existing `composerPrefill` channel.
6. **The promoted block is delivered into the active turn.** Promotion uses
   steering so the parent handles user input while delegates keep working (issue
   #1607).
7. **The turn's owner is authoritative about its end.** A runtime terminal event
   is not a reliable release: Main drops one that names a turn it no longer owns
   (`isStaleTerminalEvent`), and an abort need not produce one at all.
Session collaboration completion receipts are promoted automatically. A worker's
report is not input the user queued a minute ago: when the receiving session is
busy, the receipt runs at the very next turn boundary instead of behind the
plain queue.

## Consequences and validation

No breaking change to existing channels: `agentQueuePrioritize` /
`session.queuePrioritize` keep their names and gain the block semantics, and
`agentQueueReorder` / `session.queueReorder` are additive.
