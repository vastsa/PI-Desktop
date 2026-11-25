# ADR: Trusted extension operation ownership

- Status: Implemented candidate
- Related: #816, #788, ADR 0214, ADR 0215, spec 07-plugins/16

## Context

Retiring a hook wait alone leaves SDK subprocesses and UI requests alive, so
commands and tools can resume after Stop and publish work into the next turn,
and because trusted modules run in-process a deadline cannot terminate
arbitrary JavaScript.

## Decision

Give each factory, event handler, command, and tool execution an invocation
scope propagated through async context and retired on completion, timeout,
cancellation, and disposal, then guard SDK calls against that original scope.
Contexts and tools receive a cooperative signal, SDK subprocess groups are owned
and terminated, and UI cancellation is addressed by session, extension, and
request ID. The event and load budget is preserved but not imposed on commands
or tools, and calls already admitted to Host persistence survive a cancelled
JavaScript wait.

## Consequences

- SDK work detached from a completed callback must move into an awaited command
  or tool, and a cancelled command stops instead of continuing through
  dismissed prompts.
- Direct Node operations, escaped process groups, and synchronous JavaScript
  stay outside the cancellation guarantee, while the UI wire contract gains
  optional request identity and prompt retirement.
