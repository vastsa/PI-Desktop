# ADR 0202: Expose Effective Subagent Thinking Metadata

- Status: Accepted
- Date: 2026-09-09
- Related: ADR 0062, ADR 0089, ADR 0144, ADR 0194, D369

## Context

Delegation cards receive the provider/model chosen for each `Task` run but not the
thinking level the runtime actually passed to that delegate. That level can differ
from the parent or definition setting after inheritance and capability clamping,
and the renderer cannot infer it consistently for live, restored, and parallel
delegations.

## Decision

Resolve the delegate's effective thinking selection once, immediately before
building `SubagentRun`, through the same binding and clamping path that controls
the request. Report `modelId` and `thinkingLevel` in the immediate `Task` result,
in `SubagentRunResult`, and in lifecycle snapshots (`TaskWait`, `TaskList`,
`TaskStop`), keeping `omit` as an explicit no-override value. Delegation nodes and
the side-dock identity header render that model with a localized thinking label,
suppressing the label for `off`, `omit`, or unknown values instead of deriving one
from the parent session or the definition.

## Consequences

- One runtime-owned source of truth covers live and restored cards, and parallel
  delegates can differ without cross-talk.
- Narrow layouts stay bounded while the full label reaches the accessible name.
- `omit` shows no concrete level, because the adapter default is not a canonical
  thinking value.
