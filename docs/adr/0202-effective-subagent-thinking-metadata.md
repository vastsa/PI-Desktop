# ADR 0202: Expose Effective Subagent Thinking Metadata

- Status: Accepted
- Date: 2026-09-09
- Decision: D369
- Related: ADR 0062, ADR 0089, ADR 0144, ADR 0194

## Context

Delegation cards already receive the provider/model selected for each `Task`
run, but they do not receive the thinking level that the runtime actually
passed to that delegate. The selected level can differ from the definition or
parent setting after inheritance and target-model capability clamping. Making
the renderer infer it would make live, restored, and parallel delegations
inconsistent.

## Decision

- Resolve the delegate's effective thinking selection once, immediately before
  constructing `SubagentRun`, using the same provider binding and clamping path
  that controls the request.
- Include `modelId` and `thinkingLevel` in the immediate `Task` result, the
  `SubagentRunResult`, and lifecycle snapshots (`TaskWait`, `TaskList`, and
  `TaskStop`). `omit` remains an explicit no-provider-override value.
- Render the result's model and a localized thinking label together on each
  delegation node and in the side-dock identity header. Omit the label for
  `off`, `omit`, or any unrecognized value; never derive a replacement from
  the parent session or subagent definition.

This is additive to the existing delegation result details. It changes no host
protocol, storage schema, provider request, or delegation lifecycle behavior.

## Consequences

Live and restored cards have one runtime-owned source of truth, and parallel
delegates can show different effective levels without cross-talk. The UI can
keep narrow layouts bounded while exposing the complete combined label through
the accessible name and hover title. A provider default selected by `omit` is
intentionally not represented as a concrete visible level because the runtime
does not know that adapter-owned default as a canonical thinking value.

## Verification

Runtime tests cover result metadata and capability clamping; renderer source
contracts cover both the topology node and side-dock header, including the
`off`/`omit` suppression rule. E2E-219 records the live, narrow-layout, and
history-restoration journey.
