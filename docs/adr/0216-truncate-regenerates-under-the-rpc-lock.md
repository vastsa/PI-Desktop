# ADR 0216: Truncate Regenerates Under the RPC Lock

- Status: Accepted
- Date: 2026-09-10
- Related: ADR 0060, ADR 0127, ADR 0217, D199, D258, D307, issue #211

## Context

Retry, regenerate, and edit-resend truncated the live transcript from Electron
main through `session.get`, `session.saveRevision`, and
`session.replaceMessages`, shipping the kept transcript as one NDJSON line. A
few-thousand-message session exceeds the 64 MiB stdin line cap or the RPC
deadline, the client timeout does not cancel the host rewrite, and a retry
queues another full one while the previous turn can stay `running`.

## Decision

`session.truncateFrom` (`{ sessionId, fromMessageId?, truncateBefore? }`) is a
host-owned cut that resolves the boundary against the durable transcript, aborts
a leftover running turn, archives the discarded regenerate tail, and rewrites
the kept prefix under the state lock, returning counts and optional pager
metadata. `agent/prompt` calls it instead of `session.replaceMessages` and
`session.saveRevision` on this path, an oversized NDJSON request line is drained
to the next newline and answered with `LIMIT_EXCEEDED` instead of ending the
stdin reader, and the protocol stays at version 11. `session.replaceMessages`
remains only for callers that truly replace the whole array.

## Consequences

- Retry and regenerate on long sessions no longer ship the kept prefix through
  JSON-RPC.
- A leftover `running` turn is settled as `aborted` inside the same lock, so the
  following `beginTurn` is not `AGENT_BUSY`.
- Oversized control-pipe lines no longer take down host-core.

## Alternatives considered

- Raise the RPC deadline: rejected; the 64 MiB stdin cap still rejects the line.
- Chunk the kept array across RPCs: rejected; the snapshot stays outside the
  lock and still races `session.appendMessage`.
