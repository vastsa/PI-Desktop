# ADR 0225: Restore Deferred Tools from Effective Session Context

- Status: Accepted
- Date: 2026-09-11
- Related issue: #225
- Related pull request: #231

## Context

Lazy tool activation keeps optional schemas out of the first provider request, but a
new prompt cleared the active deferred set while keeping the successful `ToolSearch`
rows and tool results in the model context, so the model saw evidence of a capability
whose schema the request omitted. The same mismatch followed a mode switch.

## Decision

Before each new prompt and after a mode switch the sidecar clears its in-memory
deferred activation set and restores it from the effective `buildSessionContext`
projection. Where system declarations exist, their replayed active set is the
baseline and only successful results after the last declaration may add a tool, so an
earlier success cannot resurrect a later removal and the set survives a compaction
checkpoint. For older histories a successful `ToolSearch` result contributes its
`addedToolNames` and a successful deferred-tool result contributes that tool's name,
restored only while it remains in the current mode's deferred catalog. Failed,
interrupted, and placeholder rows are ignored, and prose is never activation
evidence. Registry, permission, containment, and audit behavior are unchanged.

## Consequences

Provider requests stay coherent with the retained success evidence, a restart can
reuse a deferred capability without moving optional schemas into the core set or
granting a new permission, and failed, interrupted, stale, or mode-disallowed
activations never revive a tool.

## Alternatives

- Keep clearing the set and require a new search: the model still sees the success
  marker and may call a tool whose schema is absent.
- Parse prose for tool names: prose could activate a capability that never succeeded.
