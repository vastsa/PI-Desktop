# ADR 0216: Truncate Regenerates Under the RPC Lock

- Status: Accepted
- Date: 2026-09-10
- Deciders: PI-Desktop core
- Related: D199 / ADR 0060, D258 / ADR 0127, D307, issue #211

## Context

Retry, regenerate, and edit-resend truncated the live transcript from Electron
main: `session.get` of the whole history, `session.saveRevision` of the
discarded tail, then `session.replaceMessages` with the kept prefix.

## Decision

1. `session.truncateFrom` is a host-owned cut: `{ sessionId, fromMessageId? ,
   truncateBefore? }`.
2. `agent/prompt` calls that method when a truncate is requested, loads only a
   bounded `session.get` for launch configuration, and disposes the sidecar
   session after the cut.
3. An NDJSON request line over 64 MiB is drained through to the next newline and
   answered with `LIMIT_EXCEEDED`.
4. Protocol version stays at 11.

`session.replaceMessages` remains for callers that truly replace the whole array
(message delete, unanswered smart Stop). It is still unsafe as a
read-modify-write from a snapshot taken outside the lock.

## Alternatives considered

- **Raise the 130 s deadline for `session.replaceMessages`:** the 64 MiB stdin
  cap still kills or rejects the line.
- **Chunk the kept array across many RPCs:** keeps the snapshot outside the lock
  and still races `session.appendMessage`.
- **Bump the protocol version:** handshake requires exact equality between
  components that ship together, and nothing a v11 client relies on changes.

## Consequences

- Retry and regenerate on a multi-thousand-message session no longer depend on
  shipping the kept prefix through JSON-RPC.
- A leftover `running` turn is settled as `aborted` inside the same lock, so the
  following `beginTurn` is not `AGENT_BUSY` and UI failure cannot leave sqlite
  `running`.
- Oversized control-pipe lines no longer take down host-core.
- On Windows, a leftover strong stdout sender in the Alt+Space hook could still
  keep host-core alive after stdin ended (the 130 s timeout in issue #211).
