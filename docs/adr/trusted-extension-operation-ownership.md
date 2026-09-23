# ADR: Trusted extension operation ownership

- Status: Implemented candidate
- Related: #816, #788, ADR 0214, ADR 0215, spec 07-plugins/16

## Context

Retiring a hook wait alone leaves SDK subprocesses and UI requests alive.
Commands and tools can resume after Stop and publish work into the next turn.
Trusted modules run in-process, so a deadline cannot terminate arbitrary JS.

## Decision

Give each factory, event handler, command and tool execution an invocation
scope propagated through async context. Retire the scope on completion,
timeout, cancellation and disposal. Guard SDK calls against their original
scope; pass a cooperative signal to contexts and tools. Own and terminate
SDK subprocess groups and address UI cancellation by session, extension and
request ID. Copy result-bearing event payloads and commit timely header edits.

Preserve the 30-second event/load budget, but do not impose it on commands
or tools: legitimate long tasks continue until explicitly stopped. Calls
already admitted to Host persistence are not transactions that can be undone
by cancelling a JavaScript wait. Suppress subsequent local continuation.

## Alternatives

A fixed 30-second limit for all tools would break legitimate long jobs.
Keeping session-wide cancellation alone could retire a new invocation's UI.
Executing every trusted module in a separate process would change the extension
contract and is outside this focused fix.

## Consequences

SDK work detached from a completed callback must move into an awaited command
or tool. Cancelled commands stop instead of continuing through dismissed prompts.
Direct Node operations, escaped process groups and synchronous JS remain outside
the cancellation guarantee. No new sandbox, permissions or persistence migration
is introduced. The UI wire contract gains optional request identity and prompt
retirement; older requests still support whole-session cancellation.
