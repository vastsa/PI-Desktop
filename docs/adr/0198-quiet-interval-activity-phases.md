# ADR 0198: Name every quiet interval on the live activity row

- Status: Accepted
- Date: 2026-09-09
- Related: D338, D349, D365, ADR 0175, ADR 0186

## Context

ADR 0175 added a compact status row for three quiet waits (`waiting-model`,
`retrying`, `waiting-subagents`), but a turn still looked unexplained while the
runtime compacted context, recovered a silent response, prepared the next provider
request, or waited on subagents whose child work the row did not show.

## Decision

Extend `AgentActivity` so every user-visible quiet interval has a named phase:
`starting` replaces the generic `Working…`, `preparing` covers the gap after a tool
batch and before the next provider request, `compacting` covers an in-progress
checkpoint and carries the reason (`manual` / `threshold` / `overflow`), and
`recovering` covers the silent-turn re-run until the retry request is issued.
`waiting-subagents` keeps `subagentCount` as the live running count and adds
optional `agents[]` with `name`, `lastPhase` (`waiting-model` | `thinking` | `tool`),
and `lastToolName`, updated when a child tool starts or ends or thinking begins but
never on token-level events. The renderer draws one compact localized row with a
monotonic phase timer that names the agent and its latest action or lists every
running target, and keeps it visible until completion or pending user interaction
(issue #669).

## Consequences

- Quiet compaction, recovery, and post-tool gaps are distinguishable from a hung
  turn, and a parent wait shows what delegates are doing without forwarding their
  event stream.
- Older `waiting-subagents` payloads without `agents` still render the count-only
  label.
- ADR 0175's coarse-phase rule holds: child internals stay out of the protocol
  except as this bounded snapshot.

## Alternatives

- Forward raw subagent events: expands the renderer protocol and flickers on every
  thinking token.
- Keep generic `Working…` for starting, compaction, and recovery: those intervals
  are the ones users already misread as stuck.
