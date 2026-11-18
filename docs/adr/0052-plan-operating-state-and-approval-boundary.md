# ADR 0052: Plan operating state and approval boundary

- Status: Superseded by ADR 0053
- Date: 2026-07-30
- Related: ADR 0061, ADR 0064, D188

## Context

The former product selector described Chat and Agent as two tool profiles, which
left planning ambiguous: a plan could read as a second agent, a planner model, or
a read-only permission mode. The workflow needed one pi Agent that inspects a
task, submits a structured plan, waits for a separate user decision, and only then
continues.

## Decision

The selector became exactly `Agent | Plan` over one Agent per session, with the
durable session mode `agent | plan` owned by Rust host-core. Plan exposed `Read`,
`Glob`, `Grep`, `BrowserPreview`, permission-mode-governed `Bash`, and
`ExitPlanMode`, and denied `Write`, `Edit`, and every plugin tool. Approval was a
separate host-owned `plan_approvals` transaction driven by the `plans.pending` and
`plans.resolve` RPCs, shipped with a schema v8 migration and protocol v7.

ADR 0053 supersedes this checkpoint. It keeps one Agent and a durable mode but
replaces the structured proposal and request-changes flow with immutable
host-written `.pi/plan/*.md` artifacts, approve/reject-only resolution, the
existing `plan_approvals` artifact and execution fields, and a startup
interruption fence with no replay. Context compaction left the Plan tool list
under ADR 0061 and returned as `new_context` under ADR 0064.

## Consequences

- Renderer or sidecar mode state could never authorize a tool; Rust owned the
  durable transition.
- The migration, protocol, and pending-approval details are historical; current
  Plan behavior follows ADR 0053.
