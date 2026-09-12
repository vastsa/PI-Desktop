# ADR 0217: Host Stdout Sender Must Not Outlive Serve

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop core
- Related: D390 / ADR 0216, issue #211

## Context

ADR 0216 stopped regenerate from shipping the kept transcript as one NDJSON
line, and stopped an oversize line from ending the stdin reader. That is
necessary but not sufficient for the Windows failure in issue #211.

On v0.14.6 an NDJSON line over 64 MiB made the stdin reader send an error and
break. `serve()` then dropped its stdout sender and waited for the writer
thread. On macOS and Linux that wait returns immediately because nothing else
holds the channel. On Windows, `keyboard::start` stores a strong
`UnboundedSender` in a `OnceLock` for the Alt+Space hook. That clone keeps the
writer thread blocked in `blocking_recv`, `serve()` never returns, and
host-core stays alive. Electron still considers the child available, so the
in-flight call hits the 130 s deadline (`host RPC timeout: session.replaceMessages`)
instead of `host-core exited`. A second retry also times out. The leftover
turn stays `running`.

A `LIMIT_EXCEEDED` reply with a null JSON-RPC id has the same client symptom:
Electron ignores `id: null` as a notification and waits out the deadline.

Measured on a 4659-message / 76 MB session: `session.replaceMessages` of the
kept prefix is a 56.91 MiB line and finishes in ~565 ms on macOS. The 130 s
Windows timeout is therefore not the rewrite cost. A 65 MiB line on the v0.14.6
binary exits in ~50 ms on macOS (`EPIPE` / process exit).

## Decision

1. The Windows keyboard hook retains only a `WeakUnboundedSender`. Sending a
   shortcut upgrades it. Dropping serve's last strong sender still closes the
   writer channel, so host-core can exit after stdin EOF.
2. After stdin ends, `serve()` waits at most 5 s for the stdout writer, then
   returns even if some other clone leaked. Protocol version stays at 11.
3. Electron measures the UTF-8 byte length of each host RPC payload and
   rejects a line over 64 MiB with `LIMIT_EXCEEDED` before writing stdin. The
   constant lives in `@pi-desktop/shared` and must match host-core.
4. If the host still sees an oversize line, it peeks the JSON-RPC id from the
   truncated prefix so the `LIMIT_EXCEEDED` reply can be matched.

`session.truncateFrom` remains the regenerate path (ADR 0216). Whole-transcript
`session.replaceMessages` (message delete, unanswered smart Stop) still exists;
the client precheck is the guard if those payloads grow past 64 MiB.

## Alternatives considered

- **O(tail) jsonl truncation:** makes regenerate cheaper on huge sessions, but
  does not explain the 130 s Windows timeout. Deferred.
- **Daemonize the stdout writer thread:** process exit would still wait for
  non-daemon OS threads on some platforms. Rejected in favor of dropping the
  strong sender.
- **Bump protocol version:** host and Electron ship together; nothing a v11
  client relies on is removed. Rejected, matching ADR 0216.

## Consequences

- Windows host-core exits after stdin EOF the same way macOS/Linux already did.
- An oversized control-pipe write fails immediately with `LIMIT_EXCEEDED`
  instead of `host RPC timeout`.
- A leftover strong sender cannot keep `serve()` blocked for more than 5 s.
