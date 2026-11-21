# ADR: Plugin-started subagents through the Task path

- Status: Accepted for implementation
- Date: 2026-11-21
- Related: [Issue 2508](https://github.com/vastsa/PI-Desktop/issues/2508),
  D686, ADR 0062, ADR 0089, [subagent-model-opt-in](subagent-model-opt-in.md),
  ADR 0237, ADR 0239

## Context

Orchestration plugins (for example a `superagent` tool) want to run a worker
loop: split work, delegate parts to subagents, read the reports, and decide
the next step. Today they can only reach delegation through the parent model,
by teaching it in skill text to call `Task` and `TaskWait` and guarding the
result. The plugin cannot see whether workers started, which ones finished, or
what they reported, so the loop lives in prompt text the model may not follow.

A plugin tool call has a 110 s budget (`PLUGIN_TOOL_TIMEOUT_MS`, mirrored in
host-core), while a subagent run takes minutes.

## Decision

Add a `high`-risk permission `agent.subagent` with three plugin APIs:
`pi.agent.startSubagent`, `waitSubagents`, and `stopSubagents`. They are valid
only during the calling plugin's own in-flight Agent tool invocation, and the
session, turn, and parent tool call come from that invocation, never from
plugin arguments.

The agent runtime extracts the body of the `Task` tool into one
`startDelegation` path that both `Task` and the new sidecar method
`agent.startSubagent` use, so catalog, model opt-in, concurrency cap, worktree
isolation, turn-epoch checks, abort, and child events stay one implementation.
Child events carry the plugin tool call as `parentToolCallId`. Start returns at
once; `agent.waitSubagents` is a structured wait capped at 90 s, below the tool
budget, and marks returned reports delivered so the idle auto-resume does not
repeat them. Stop reuses `agent.stopSubagents`. Electron main owns which plugin
started which delegation id per session and refuses any other id.

## Consequences

- An orchestration plugin can run its own worker loop with real status and
  reports, while every delegation still obeys the rules a `Task` call obeys.
- `Task` keeps its schema and output; the shared path changes no model-facing
  text. `agent.stopSubagents` gains an additive `stopped` id list.
- Reports a plugin never reads still reach the parent model through the idle
  auto-resume. Plugin cancellation or unload does not stop started runs, the
  same as a `Task` call; user Stop and `TaskStop` do.
- Ownership lives in Electron main memory: it ends on plugin unload, reload, or
  crash, and ids from a disposed session runtime answer `NOT_FOUND`.
- Tool budgets are unchanged.

## Alternatives

- One blocking `runSubagent` call: a run outlasts the 110 s plugin tool budget,
  and raising that budget would widen every plugin tool's hang window.
- Extending `session/collaboration/spawn` (ADR 0237 / 0239): that path creates
  durable top-level sessions with their own transcript and permission ceiling,
  not in-turn delegates that share the parent's context budget and worktree.
- Keeping skill text plus a guard tool: leaves the loop to the model and gives
  the plugin no reliable status or report access.
