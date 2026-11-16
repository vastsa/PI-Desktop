# ADR 0153: Checkpoint the streaming reply beside the transcript

- Status: Accepted (amended 2026-09-06 by D327)
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D119, D287, D288, D299, D327, E2E-010, E2E-171, E2E-184, ADR 0030, ADR 0041

## Context

Spec 04 makes assistant and tool rows durable at their end events: the agent
runtime emits `message_end` once, and Electron main appends that row through the
persistence outbox. Everything the user watches stream before that point lives
only in the renderer and in the sidecar's memory.

## Decision

1. **Checkpoint file, not transcript lines.** Host-core owns
   `sessions/<id>.inflight.json`: one atomically replaced object holding the
   session's streaming assistant message and its turn id.
2. **Settlement rules.** The final `session.appendMessage` of the same id
   removes the file.
3. **Quit settles turns first.** `before-quit` flushes checkpoints, aborts
   active turns through the sidecar, and waits at most 2 s for the aborted rows
   to drain while host-core is alive, then disposes host and sidecar.
4. **Renderer Stop never rewrites a started reply.** Settling is in-memory; the
   durable copy is the runtime's aborted row or the promoted checkpoint.

## Consequences

- Loss on quit or crash is bounded to the last 1.5 s of a reply plus tool rows
  still running; the reopened session shows the prompt and the partial reply as
  an `aborted` row under an `aborted` turn.
- One small file write per interval per streaming session; nothing new in
  SQLite.
- Session delete removes the checkpoint file with the other session files.
- Spec 01 §5.3, 04 §2.1 and §4.7, 06, 07 §5; E2E-171; D299.

## Amendment (2026-09-06) — Completed replies survive process restart (D327)

Issue #42 showed the same user-only transcript after a full quit that D324 fixed
for an in-process session switch. Two settlement rules dropped a finished reply
that was still only in the outbox:

1. `message_end` called `settle()` before enqueueing, so the host checkpoint was
   up to 1.5 s stale and a trailing write of the finished snapshot was
   cancelled.
2. `session.endTurn` for `completed`/`error` deleted the checkpoint even when
   that id was not yet indexed.

Amendment:

- Electron main checkpoints the finished `message_end` snapshot, then `settleIf`
  so a newer turn started during that write is not wiped.
- `completed`/`error` endTurn deletes the checkpoint only when the final row is
  already indexed.
- Boot/recovery promotion of a leftover whose turn is `completed` writes the row
  as `complete`, not `aborted`.
- Host handshake **awaits** the persistence outbox drain before the renderer can
  `session.get`, then calls `session.recoverInflightMessages` (amends ADR 0041).
