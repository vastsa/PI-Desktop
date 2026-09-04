# ADR 0153: Checkpoint the streaming reply beside the transcript

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D119, D287, D288, D299, E2E-010, E2E-171, ADR 0030

## Context

Spec 04 makes assistant and tool rows durable at their end events: the agent
runtime emits `message_end` once, and Electron main appends that row through
the persistence outbox. Everything the user watches stream before that point
lives only in the renderer and in the sidecar's memory. Agentic replies stream
for minutes, and the app is quit or restarted often. A quit, a sidecar crash,
or a restart mid-reply therefore lost the entire reply: the boot sweep marked
the turn `aborted`, and the reopened session showed the prompt with nothing
under it. Session logs from this week show eight such turns in one day.

Two smaller defects compounded it. `before-quit` disposed host-core first and
then killed the sidecar outright, so even a reply that had reached its final
message could not be persisted. And the renderer's Stop path, for long
sessions, re-read the durable transcript, replaced its live rows with it, and
rewrote the transcript from that snapshot; the runtime's aborted final row was
usually still in the outbox, so the rewrite hid the reply immediately and could
delete it if the append landed in between. The same rewrite wrote the
renderer's 64 KB display-capped rows back over the full ones.

## Decision

1. **Checkpoint file, not transcript lines.** Host-core owns
   `sessions/<id>.inflight.json`: one atomically replaced object holding the
   session's streaming assistant message and its turn id. Electron main
   observes `message_update`, keeps the newest snapshot, and calls
   `session.saveInflightMessage` at most every 1.5 s with a trailing write.
   Appending checkpoints as transcript lines was rejected: a multi-minute
   reply would leave dozens of near-copies that bloat the file and skew the
   physical-line paging window.
2. **Settlement rules.** The final `session.appendMessage` of the same id
   removes the file. `session.endTurn` removes it for `completed`/`error`,
   promotes it as an `aborted` assistant row when asked to `recoverInflight`
   (sidecar gone), and leaves it alone for a plain `aborted` (user Stop) so the
   runtime's own final row can supersede it. Host boot promotes every leftover
   whose final row never landed. A checkpoint for an id that is already indexed
   is dropped, so a write still in flight when the final row lands cannot
   resurrect it. Checkpoints bypass the outbox; delegate replies are not
   checkpointed.
3. **Quit settles turns first.** `before-quit` flushes checkpoints, aborts
   active turns through the sidecar, and waits at most 2 s for the aborted rows
   to drain while host-core is alive, then disposes host and sidecar.
4. **Renderer Stop never rewrites a started reply.** Settling is in-memory;
   the durable copy is the runtime's aborted row or the promoted checkpoint.
   The unanswered-prompt undo and message delete rewrite only from the full
   durable transcript merged with the live rows, and the undo is re-evaluated
   on that merge.

## Consequences

- Loss on quit or crash is bounded to the last 1.5 s of a reply plus tool rows
  still running; the reopened session shows the prompt and the partial reply as
  an `aborted` row under an `aborted` turn.
- One small file write per interval per streaming session; nothing new in
  SQLite. `session.endTurn` gains `recoverInflight` and `recovered`.
- Session delete removes the checkpoint file with the other session files.
- Spec 01 §5.3, 04 §2.1 and §4.7, 06, 07 §5; E2E-171; D299.
