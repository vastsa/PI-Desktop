# ADR: A user stop preserves tool side-effect boundaries

- Status: Accepted for implementation
- Date: 2026-10-20 (amended 2026-10-23)
- Issues: #1767
- Amends: spec 03-runtime/03-tools-and-permissions.md §3

## Context

The runtime registered an abort listener for every tool call but returned
immediately unless the tool was `Bash` or `GenerateImages`. For every other
tool — `Grep`, `Read`, `Glob`, `WebFetch`, plugin tools — the listener was
inert, and `tools.execute` was awaited with no deadline and no race against the
signal. The agent loop only re-checks `signal.aborted` between tool calls, so a
single long call held the turn, and the session, hostage: one report measured a
`Grep` that ran 21m39s after the user clicked Stop six times, with the abort
applying in the same millisecond the tool finally returned.

The fix must avoid telling the user that a turn stopped while a pending
permission can still be approved or a mutating extension call is still running.
Three facts constrain the fix:

1. Host cancellation can close a pending permission and remote calls. Bash and
   image generation also have process cancellation. Local file writes and
   desktop-dispatched MCP/plugin calls cannot be safely abandoned after their
   operation has started.
2. Bash process aborts retain their short-lived early-arrival tombstones. Other
   tool aborts use a separate registry keyed by session, call id, and tool name,
   so a delayed abort cannot affect a different tool that reuses the call id.
3. `TOOL_ABORTED` already means "the tool was cancelled by a user stop or a turn
   abort before it finished" (spec 03-runtime/08-error-codes.md), so the runtime
   may report that outcome without host cooperation.

## Decision

The runtime sends typed `tools.abort` requests for in-flight tools. Host-core
registers cancellation before permission evaluation, so stopping a pending
approval or queued tool prevents it from starting. Local `Read` calls retain
their existing immediate local-abandon policy. `Glob` and `Grep` instead use
cooperative host cancellation and await their blocking worker and any owned
search process termination/reaping before the runtime settles.

For `Bash` and `GenerateImages`, the runtime waits a bounded 10s grace window
for the host to return output collected before process termination. For
mutating, MCP, and plugin calls, the runtime waits for the host result after
requesting cancellation. A pending permission is cancelled; an operation that
already started is not reported as stopped until its result arrives.

`Read` and process-backed tools race their execution against cancellation.
For a local `Read`, the blocking worker may outlive the RPC and its result is
discarded. Searches, mutations, and desktop-dispatched tools are not locally
abandoned while active. A remote search sends cancellation but keeps its relay
ownership until remote completion or the existing transport failure deadline;
a timeout/disconnection is observable failure, not confirmed Stop settlement.

The runtime also drives the tools from `abort()` itself, not only from the
signal each tool was handed. `abort()` walks the in-flight tool calls and runs
the same handler the signal would. Relying on the signal alone was not enough:
a stop can reach the runtime without reaching the tool, and then `abort()` stays
blocked on the turn settlement, which keeps the `agent.abort` RPC pending. The
renderer awaits that RPC before it clears "processing", so the session stayed
pinned even after the turn was over in the ledger. One field report showed
exactly that: three turns recorded `aborted` while the tool's process was still
alive minutes later.

## Consequences

- Search Stop interrupts traversal, chunked reads, tag processing, and quiet
  `rg` processes instead of leaving background search work behind. The local
  admission permit remains owned until worker/process cleanup completes.
- `Read` workers and already-started extension operations may still consume
  resources until they return. Mutating and extension results remain observable
  before the runtime reports the turn settled.
- A new turn uses distinct tool call ids. Typed abort records also prevent an
  early abort for one tool name from being inherited by another tool.
- Progress output for an abandoned call stops at the moment of the stop.

## Alternatives

- **Locally abandon every tool.** Could report a stopped turn while a pending
  `Write` approval is later accepted or an already-started plugin/MCP action
  continues. Rejected because it hides side effects.
- **Only arm a grace timer on abort (no race for cancellable tools).** Simpler,
  but leaves every non-cancellable tool waiting the full window and still keeps
  the turn blocked for that window.
- **Wait for host-core to grow cancellation for every tool.** The search
  implementation now cooperatively cancels its owned work. Broader interruption
  of mutating and extension operations remains outside this change.
