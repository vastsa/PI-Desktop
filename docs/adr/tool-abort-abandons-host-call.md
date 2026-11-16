# ADR: A user stop preserves tool side-effect boundaries

- Status: Accepted for implementation
- Date: 2026-10-20 (amended 2026-10-23)
- Issues: #1767
- Amends: spec 03-runtime/03-tools-and-permissions.md §3

## Context

The runtime registered an abort listener for every tool call but returned
immediately unless the tool was `Bash` or `GenerateImages`. For every other tool
— `Grep`, `Read`, `Glob`, `WebFetch`, plugin tools — the listener was inert, and
`tools.execute` was awaited with no deadline and no race against the signal.

1. Host cancellation can close a pending permission and remote calls.
2. Bash process aborts retain their short-lived early-arrival tombstones.
3. `TOOL_ABORTED` already means "the tool was cancelled by a user stop or a turn
   abort before it finished" (spec 03-runtime/08-error-codes.md), so the runtime
   may report that outcome without host cooperation.

## Decision

The runtime sends typed `tools.abort` requests for in-flight tools. Host-core
registers cancellation before permission evaluation, so stopping a pending
approval or queued tool prevents it from starting.

For `Bash` and `GenerateImages`, the runtime waits a bounded 10s grace window
for the host to return output collected before process termination. For
mutating, MCP, and plugin calls, the runtime waits for the host result after
requesting cancellation.

## Consequences

- A long-running read-only tool no longer holds the turn open after Stop, while
  pending permission prompts and admission waits are cancelled at the host.
- Local filesystem workers and already-started extension operations may still
  consume resources until they return.
- A new turn uses distinct tool call ids.
- Progress output for an abandoned call stops at the moment of the stop.

## Alternatives

- **Locally abandon every tool.** Could report a stopped turn while a pending
  `Write` approval is later accepted or an already-started plugin/MCP action
  continues.
- **Only arm a grace timer on abort (no race for cancellable tools).** Simpler,
  but leaves every non-cancellable tool waiting the full window and still keeps
  the turn blocked for that window.
- **Wait for host-core to grow cancellation for every tool.** Correct durable
  fix, tracked separately; it cannot ship as a bug fix for a turn that is stuck
  today.
