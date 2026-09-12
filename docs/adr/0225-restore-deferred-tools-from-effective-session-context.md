# ADR 0225: Restore Deferred Tools from Effective Session Context

- Status: Accepted
- Date: 2026-09-11
- Related issue: #225
- Related pull request: #231

## Context

Lazy tool activation keeps optional schemas out of the first provider request,
but a new prompt previously cleared the active deferred set while retaining the
successful `ToolSearch` rows and tool results in the model context. The model
could therefore see evidence that a capability was available while the next
request omitted its schema. The same mismatch occurred after a mode switch.

## Decision

Before each new prompt and after a mode switch, the sidecar clears its in-memory
deferred activation set and restores it from the effective `buildSessionContext`
projection. A successful `ToolSearch` result contributes its `addedToolNames`;
a successful result from a deferred tool contributes that tool's name. A name
is restored only when it remains in the current mode's deferred catalog. Failed,
interrupted, or missing-result placeholder rows are ignored, and assistant/user
prose is never parsed as activation evidence.

The existing tool registry, host permission checks, workspace and scratch
containment, timeouts, and audit behavior remain unchanged. Compaction and mode
catalog rebuilding continue to define which historical markers are effective.

## Consequences

- Provider requests remain coherent with the successful tool evidence retained
  in the effective transcript.
- A runtime restart can reuse a deferred capability when its successful marker
  remains in effective context, without moving optional schemas into the core
  set or granting a new permission.
- Failed, interrupted, stale, and mode-disallowed activations do not revive a
  deferred tool.

## Alternatives

### Keep clearing the set and require a new search

Rejected because the model still receives the successful activation marker and
may call a tool whose schema is absent from the request.

### Parse assistant or user prose for tool names

Rejected because prose is not authoritative activation evidence and could
activate a capability that never succeeded or is no longer allowed.

## References

- `docs/adr/0048-lazy-per-turn-tool-activation.md`
- `docs/spec/03-runtime/02-agent-runtime.md` §7.1
- `docs/spec/03-runtime/03-tools-and-permissions.md` §2.1
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-008a
