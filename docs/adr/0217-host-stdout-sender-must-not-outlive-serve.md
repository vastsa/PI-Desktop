# ADR 0217: Host Stdout Sender Must Not Outlive Serve

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop core
- Related: D390 / ADR 0216, issue #211

## Context

ADR 0216 stopped regenerate from shipping the kept transcript as one NDJSON
line, and stopped an oversize line from ending the stdin reader. That is
necessary but not sufficient for the Windows failure in issue #211.

## Decision

1. The Windows keyboard hook retains only a `WeakUnboundedSender`.
2. After stdin ends, `serve()` waits at most 5 s for the stdout writer, then
   returns even if some other clone leaked.
3. Electron measures the UTF-8 byte length of each host RPC payload and rejects
   a line over 64 MiB with `LIMIT_EXCEEDED` before writing stdin.
4. If the host still sees an oversize line, it peeks the JSON-RPC id from the
   truncated prefix so the `LIMIT_EXCEEDED` reply can be matched.

`session.truncateFrom` remains the regenerate path (ADR 0216). Whole-transcript
`session.replaceMessages` (message delete, unanswered smart Stop) still exists;
the client precheck is the guard if those payloads grow past 64 MiB.

## Alternatives considered

- **O(tail) jsonl truncation:** makes regenerate cheaper on huge sessions, but
  does not explain the 130 s Windows timeout.
- **Daemonize the stdout writer thread:** process exit would still wait for
  non-daemon OS threads on some platforms.
- **Bump protocol version:** host and Electron ship together; nothing a v11
  client relies on is removed.

## Consequences

- Windows host-core exits after stdin EOF the same way macOS/Linux already did.
- An oversized control-pipe write fails immediately with `LIMIT_EXCEEDED`
  instead of `host RPC timeout`.
- A leftover strong sender cannot keep `serve()` blocked for more than 5 s.
