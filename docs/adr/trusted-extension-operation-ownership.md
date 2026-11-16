# ADR: Trusted extension operation ownership

- Status: Implemented candidate
- Related: #816, #788, ADR 0214, ADR 0215, spec 07-plugins/16

## Context

Retiring a hook wait alone leaves SDK subprocesses and UI requests alive.
Commands and tools can resume after Stop and publish work into the next turn.

## Decision

Give each factory, event handler, command and tool execution an invocation scope
propagated through async context. Retire the scope on completion, timeout,
cancellation and disposal.

Preserve the 30-second event/load budget, but do not impose it on commands or
tools: legitimate long tasks continue until explicitly stopped. Calls already
admitted to Host persistence are not transactions that can be undone by
cancelling a JavaScript wait.

## Alternatives

A fixed 30-second limit for all tools would break legitimate long jobs.

## Consequences

SDK work detached from a completed callback must move into an awaited command or
tool.
