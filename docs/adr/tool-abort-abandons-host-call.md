# ADR: A user stop preserves tool side-effect boundaries

- Status: Accepted for implementation (amended 2026-10-23; amends
  `03-runtime/03-tools-and-permissions.md` §3)
- Date: 2026-10-20
- Related: issue #1767

## Context

The runtime registered an abort listener for every tool call but returned
immediately unless the tool was `Bash` or `GenerateImages`, so for `Grep`, `Read`,
`Glob`, `WebFetch`, and plugin tools the listener was inert and `tools.execute` was
awaited with no deadline or race against the signal, letting one long call hold the
turn and session hostage. Local file writes and desktop-dispatched MCP/plugin calls
cannot be safely abandoned once started, but `TOOL_ABORTED` already means "cancelled
by a user stop or turn abort before it finished"
(`03-runtime/08-error-codes.md`), so the runtime may report that outcome without host
cooperation.

## Decision

The runtime sends typed `tools.abort` requests for in-flight tools, and Host-core
registers cancellation before permission evaluation, so stopping a pending approval
or queued tool prevents it from starting. Local `Read`, `Glob`, and `Grep` calls end
the runtime's wait immediately because they are read-only, with the host observing
cancellation and discarding their result. `Bash` and `GenerateImages` get a bounded
10s grace window for output collected before process termination, while mutating,
MCP, and plugin calls wait for the host result after cancellation: a pending
permission is cancelled, and an operation that already started is not reported as
stopped until its result arrives. Abort records are keyed by session, call id, and
tool name so a delayed abort cannot affect a different tool that reuses the call id,
and `abort()` itself walks the in-flight calls and runs the same handler instead of
relying on the signal alone.

## Consequences

- A long-running read-only tool no longer holds the turn open after Stop, while
  pending permission prompts and admission waits are cancelled at the host.
- Local filesystem workers and already-started extension operations may consume
  resources until they return, and progress output for an abandoned call stops at the
  stop.
- A new turn uses distinct call ids, and typed abort records keep one tool name's
  abort from being inherited by another.

## Alternatives

- Locally abandon every tool: could report a stopped turn while a pending `Write`
  approval is later accepted.
- Only arm a grace timer on abort: leaves every non-cancellable tool waiting the full
  window.
