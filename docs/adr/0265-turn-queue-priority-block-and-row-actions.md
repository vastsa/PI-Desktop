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

The queued row also only offered Remove and Send now. Users could not correct a
queued prompt without deleting it and retyping, and could not reorder the plain
queue at all even though the Host already orders it by a durable `position`.

## Decision

1. **A promotion block, ordered by click.** `turn_queue` gains a nullable
   `priority` column (schema v18). Promoting an entry writes
   `COALESCE(MAX(priority), 0) + 1` inside the session, so the first promotion
   is delivered first and each later promotion queues behind it. Delivery order
   is `priority ASC, position ASC` for promoted entries followed by
   `position ASC` for the rest; the plain queue keeps its own order.
2. **Promotion is one-way and idempotent-hostile.** Promoting an entry that
   already carries a `priority` fails with `CONFLICT`/`ALREADY_PRIORITIZED`
   instead of silently moving it again. `session.queuePrioritize` keeps moving
   optimistic mirror does the same.
3. **A promoted row is locked.** Because the Host has already committed to
   starting it, its row disables move up, move down, edit, and remove, and its
   Send now button reads as decided (`chat.sendNowPending`). The disabled
   controls keep their tooltip and `aria-disabled` state so the lock is
   explained rather than silent. There is deliberately no un-promote path: a
   promotion cannot be half-applied.
4. **A reorder operation for the plain queue.** `session.queueReorder` swaps one
   entry's `position` with its adjacent non-prioritized neighbour in the
   requested direction, and reports `moved: false` for a missing entry, a
   promoted entry, or a block/queue edge. Promoted entries are never neighbours,
   so reordering can never cross into the priority block. The renderer mirrors
   one swap and never reaches the Host for a boundary no-op.
5. **Edit returns the row to the composer.** Editing is renderer-local: the row
   is removed (through the existing removal path) and its captured
   `ComposerDraftSnapshot` — text plus inline file references — replaces the
   composer input through the existing `composerPrefill` channel. The
   token-stripped `content` is never used to rebuild the prompt. The action is
   refused with a toast while the input is non-empty, and the emptiness check
   runs against the live editor read because the draft cache is not written per
   keystroke.
6. **The promoted block is delivered as adjacent messages, not as separate
   turns.** Promotion still does not touch the running turn by itself: the
   renderer requests the existing graceful `agent/stop`, and the block leaves at
   the next boundary. The first promoted entry then starts the turn, and every
   later promoted entry is injected into that same turn as user input over the
   Composer's existing steering channel. The transcript therefore reads
   `user: first`, `user: second` and the model answers once. The injection is
   retried a bounded number of times because the runtime only accepts input for
   a live run; an entry that is still undelivered stays queued and leaves at the
   next boundary as its own turn, which is the previous behavior and never a
   lost prompt. An injected entry's own RACP turn is canceled: its input was
   delivered by another turn, and no client may be left believing it is still
   waiting.
7. **The turn's owner is authoritative about its end.** A runtime terminal event
   is not a reliable release: Main drops one that names a turn it no longer owns
   (`isStaleTerminalEvent`), and an abort need not produce one at all. A turn
   left active inside the module holds its session's queue forever, which is how
   "Send now, then Stop" stranded a queued row. So the settlement reported by
   `finishTurn` closes the turn in the module (marking it as the settlement
   reason, canceling its approvals and inputs) and lets the queue run, and the
   module's drain request is remembered while a pass is running instead of being
   dropped.

## Consequences and validation

No breaking change to existing channels: `agentQueuePrioritize` /
`session.queuePrioritize` keep their names and gain the block semantics, and
`agentQueueReorder` / `session.queueReorder` are additive. Existing rows migrate
with `priority = NULL`, so an upgraded database keeps its FIFO order and its
eight-entry bound. Row-level unit coverage lives in `turn_queue` tests
(promotion order, reorder, prioritized-row rejection, v16 upgrade),
`turn-queue.test.ts` / `agent-host.test.ts` (block order, permissions), and
`composer-send-state.test.mjs` (lock, reorder, and edit contracts). The rendered
journeys are specified as E2E-QUEUE-promote-orders-delivery-by-click,
E2E-QUEUE-reorder-moves-plain-neighbours, and
E2E-QUEUE-edit-restores-draft-only-when-input-empty, and remain Draft until
rendered E2E validation is performed.
