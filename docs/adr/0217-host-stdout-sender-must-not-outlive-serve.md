# ADR 0217: Host Stdout Sender Must Not Outlive Serve

- Status: Accepted
- Date: 2026-09-11
- Related: ADR 0216, D390, issue #211

## Context

ADR 0216 stopped regenerate from shipping the kept transcript as one NDJSON line,
but on Windows an oversize line still hung shutdown: the Alt+Space keyboard hook
holds a strong sender clone, so the stdout writer thread never unblocks,
`serve()` never returns, and Electron reports a host RPC timeout instead of a
dead host. A `LIMIT_EXCEEDED` reply with a null JSON-RPC id had the same client
symptom, because Electron treats `id: null` as a notification.

## Decision

1. The Windows keyboard hook keeps only a weak sender and upgrades it when a
   shortcut is sent, so dropping serve's last strong sender still closes the
   writer channel.
2. After stdin ends, `serve()` waits at most 5 s for the writer and then returns
   even if some clone leaked; protocol version stays at 11.
3. Electron measures each host RPC payload and rejects a line over 64 MiB with
   `LIMIT_EXCEEDED` before writing stdin, using one shared constant that matches
   host-core.
4. If the host still sees an oversize line, it peeks the JSON-RPC id from the
   truncated prefix so the reply can be matched.

`session.truncateFrom` remains the regenerate path (ADR 0216), and
`session.replaceMessages` stays available behind the client precheck.

## Consequences

- Windows host-core exits after stdin EOF like macOS and Linux.
- An oversized control-pipe write fails immediately with `LIMIT_EXCEEDED`
  instead of a deadline.
- A leaked strong sender cannot block `serve()` beyond the bounded wait.

## Alternatives

- O(tail) jsonl truncation: rejected as the fix because it does not explain the
  hung shutdown; deferred.
- Bump the protocol version: rejected because host and Electron ship together and
  no v11 client capability is removed.
