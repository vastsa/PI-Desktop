# ADR 0153: Checkpoint the streaming reply beside the transcript

- Status: Accepted (amended 2026-09-06 by D327)
- Date: 2026-09-05
- Related: ADR 0030, ADR 0041, D119, D287, D288, D299, D327, E2E-010,
  E2E-171, E2E-184

## Context

Assistant and tool rows become durable only at their end events, so everything
streaming before that point lives in the renderer and sidecar memory. Agentic
replies stream for minutes and the app is quit or restarted often, so a quit, a
sidecar crash, or a restart mid-reply lost the entire reply under an `aborted`
turn. `before-quit` disposed host-core before the sidecar could persist a final
row, and the renderer Stop path rewrote the transcript from a stale snapshot,
hiding or deleting the reply.

## Decision

1. **Checkpoint file, not transcript lines.** Host-core owns
   `sessions/<id>.inflight.json`, one atomically replaced object holding the
   streaming assistant message and its turn id, which Electron main writes from
   `message_update` through `session.saveInflightMessage` at a bounded interval
   with a trailing write.
2. **Settlement rules.** The final `session.appendMessage` of that id removes the
   file, `session.endTurn` removes it for `completed`/`error`, promotes it as an
   `aborted` row when asked to `recoverInflight`, and leaves it for a plain user
   Stop; host boot promotes leftovers whose final row never landed, and a
   checkpoint for an already indexed id is dropped.
3. **Quit settles turns first.** `before-quit` flushes checkpoints, aborts active
   turns through the sidecar, and waits a bounded time for the aborted rows to
   drain while host-core is alive before disposing host and sidecar.
4. **Renderer Stop never rewrites a started reply.** Settling stays in memory, the
   durable copy is the runtime's aborted row or the promoted checkpoint, and the
   undo and delete paths rewrite only from the full durable transcript merged
   with the live rows.

Amended 2026-09-06 (D327, issue #42, after D324): `message_end` checkpoints the
finished snapshot and then settles only a newer turn, `completed`/`error` endTurn
deletes the checkpoint only when the final row is already indexed, boot promotion
of an already-completed turn writes its leftover as `complete` instead of
`aborted`, and the host handshake awaits the persistence outbox drain before the
renderer can call `session.get`, then calls `session.recoverInflightMessages`
(amending ADR 0041).

## Consequences

- Loss on quit or crash is bounded to the last interval of a reply plus tool rows
  still running; the reopened session shows the partial reply as an `aborted` row.
- One small file write per interval per streaming session and nothing new in
  SQLite; `session.endTurn` gains `recoverInflight` and `recovered`.
- Session delete removes the checkpoint file with the other session files.

## Alternatives

- Append checkpoints as transcript lines: rejected; a multi-minute reply would
  leave dozens of near-copies that bloat the file and skew line paging.
- Skip quit-time settling: rejected; a reply that reached its final message would
  still be unpersistable.
