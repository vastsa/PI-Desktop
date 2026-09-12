# ADR 0198: Name every quiet interval on the live activity row

- Status: Accepted
- Date: 2026-09-09
- Related: ADR 0175, ADR 0186, D338, D349, D365

## Context

ADR 0175 added a compact runtime status row for three quiet waits:
`waiting-model`, `retrying`, and `waiting-subagents`. Users still saw a
long-running turn with no explanation when the runtime was compacting
context, recovering a silent response, preparing the next provider request,
or waiting on subagents whose child work was invisible on that row. The
generic `Working…` fallback also hid `starting`. A parent wait that only
said "Waiting for 2 subagents" for more than a minute looked stuck even
when the delegates were reading and searching.

The row must stay a single compact inline status. It must not restore the
activity-group current-state capsule removed after ADR 0175, and it must
not stream raw child events.

## Decision

Extend `AgentActivity` so every user-visible quiet interval has a named
phase, and enrich `waiting-subagents` with a live snapshot of running
targets:

1. `starting` is rendered instead of generic `Working…`.
2. `preparing` covers the gap after a tool batch and before the next
   provider request.
3. `compacting` covers an in-progress checkpoint and carries the reason
   (`manual` / `threshold` / `overflow`).
4. `recovering` covers the silent-turn re-run until the retry request is
   issued.
5. `waiting-subagents` keeps `subagentCount` as the live running count and
   adds optional `agents[]` with `name`, `lastPhase`
   (`waiting-model` | `thinking` | `tool`), and `lastToolName`. The snapshot
   updates when a child tool starts/ends or thinking begins; token-level
   child events do not emit a new status.

The renderer still draws one compact localized row with a monotonic phase
timer. A one-subagent wait names the agent and its latest action; a
multi-agent wait lists each running target. Thinking, tool, answer, and
permission surfaces continue to replace the row. No second progress card
or percentage is added.

## Consequences

- Quiet compaction, recovery, and post-tool gaps are distinguishable from a
  hung turn.
- A parent wait on delegates shows what those delegates are doing without
  forwarding their event stream.
- Older `waiting-subagents` payloads without `agents` still render the
  count-only label.
- ADR 0175's coarse-phase rule still holds: child internals stay out of the
  protocol except as this bounded snapshot.

## Alternatives

### Restore a current-state capsule on the processing group

Rejected because it duplicated the dedicated runtime row and was already
removed as redundant chrome.

### Forward raw subagent events onto the parent status row

Rejected because it would expand the renderer protocol and flicker on every
thinking token. A coarse `lastPhase` / `lastToolName` snapshot is enough to
explain the wait.

### Keep generic `Working…` for starting, compaction, and recovery

Rejected because those intervals are the ones users already misread as a
stuck turn.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-008c, E2E-094)
