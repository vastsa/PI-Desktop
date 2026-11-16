# ADR 0265: Priority block and row actions for the Host-owned turn queue

- Status: Accepted for implementation
- Date: 2026-09-15
- Amends: ADR 0213 (persisted Host-owned turn queue), ADR 0118 (renderer-owned
  queued prompts and turn-boundary stops)

## Context

ADR 0213 moved the queue into host-core, where `prioritize` rewrites an entry's
`position` below the current minimum so it jumps to the head of the whole queue.
The renderer mirrored that as one in-memory `sendNowRequested` flag cleared by
every other row, so only one row could wait for the next boundary and two clicks
resolved as "the last wins". The row also offered only Remove and Send now, so a
prompt could not be corrected without retyping and the plain queue could not be
reordered at all.

## Decision

1. **A promotion block, ordered by click.** `turn_queue` gains a nullable
   `priority` column (schema v18). Promotion writes
   `COALESCE(MAX(priority), 0) + 1` within the session, so the first promotion is
   delivered first; delivery is `priority ASC, position ASC` for promoted entries
   followed by `position ASC` for the rest.
2. **Promotion is one-way and idempotent-hostile.** Promoting an entry that
   already carries a `priority` fails with `CONFLICT`/`ALREADY_PRIORITIZED`
   instead of moving it again, and the renderer's optimistic mirror follows the
   same rule.
3. **Promotion fixes order, not cancellation.** A promoted row disables move up,
   move down, edit, and Send now and reads Waiting to send, while Remove survives
   until delivery and waits for Host confirmation. Cancellation, promotion,
   reordering, and delivery reservation share session admission serialization;
   runtime delivery runs outside that lock and reserves only its own input. Once
   input is reserved or accepted as steering, cancellation returns `CONFLICT`, and
   refused steering keeps the queued input for the next turn. There is no
   un-promote path.
4. **A reorder operation for the plain queue.** `session.queueReorder` swaps an
   entry's `position` with its adjacent non-prioritized neighbour and reports
   `moved: false` for a missing or promoted entry or a block edge, so reordering
   never crosses into the priority block.
5. **Edit returns the row to the composer.** Editing is renderer-local: the row is
   removed through the existing path and its captured `ComposerDraftSnapshot` —
   text plus inline file references — replaces the composer input through
   `composerPrefill`. The token-stripped `content` never rebuilds the prompt, and
   the action is refused while the live editor is non-empty.
6. **The promoted block is delivered into the active turn.** Promotion uses
   steering so the parent handles user input while delegates keep working (issue
   #1607): an active `TaskWait` yields to accepted steering while ordinary tools
   keep their boundaries. Immediate delivery accepts only the paired caller's own
   input under the active turn's permission mode — external Desktop turns use the
   stored session mode, module-admitted turns their principal ceiling — and other
   input keeps turn-boundary delivery. Without an active turn the first promoted
   entry starts the turn and later ones join as steering in click order; refusals
   are retried within a bounded budget, and an injected entry's own RACP turn is
   canceled.
7. **The turn's owner is authoritative about its end.** A runtime terminal event
   is not a reliable release: Main drops one naming a turn it no longer owns
   (`isStaleTerminalEvent`), and an abort need not produce one at all. A turn left
   active in the module would hold its session's queue forever, so the settlement
   reported by `finishTurn` closes the turn and lets the queue run, and the
   module's drain request is remembered while a pass runs instead of dropped.

Session collaboration completion receipts are promoted automatically, so a
worker's report runs at the next turn boundary rather than behind the plain queue,
under the same promotion and steering rules.

## Consequences

- Existing channels keep their names: `agentQueuePrioritize` /
  `session.queuePrioritize` gain the block semantics and `agentQueueReorder` /
  `session.queueReorder` are additive.
- Rows migrate with `priority = NULL`, so an upgraded database keeps its FIFO
  order and eight-entry bound.
