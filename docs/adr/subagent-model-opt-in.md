# ADR: Separate Subagent Model Opt-In from Definition Pins

- Status: Accepted for implementation
- Date: 2026-09-13
- Related: D278, ADR 0062, ADR 0089, ADR 0237, E2E-166, issues #286, #386

## Context

Electron resolved definition pins and automatically selectable models into one
credential-bearing `subagentProviders` map, and treating every map key as a
`Task.model` selection both advertised private pins and bypassed main's
`availableForSubagents` check. A definition pin expresses one delegate's default, not
permission to select that model for any delegate.

## Decision

Add an optional `subagentModelKeys: string[]` to the Electron-to-sidecar launch
payload, runtime options, and reuse comparison, filled only from resolved bindings
independently marked `availableForSubagents`, while `subagentProviders` keeps carrying
all bindings so definition defaults still work. Reusing a resolved pin does not skip
that opt-in decision, and when an opted-in row's alias collides with another row's
binding, main uses that row's exact provider id, so one account's opt-in cannot
authorize another account's pinned credentials.

The runtime uses those keys for its model summary, and missing keys mean no cached
override authorization. Other keys still pass `provider.resolveSubagentModel`, whose
response may fill a separate override cache that never takes part in launch reuse
matching; on-demand matching uses the same unique id, vendor, and name rule and fails
closed on ambiguous aliases, a changed launch list retires an idle runtime on the next
prompt, and on-demand grants expire at every new parent prompt or approved plan/goal
execution.

The opt-in governs every entry point through which the AI picks a model for delegated
work, including `session/collaboration/spawn` (ADR 0237), whose `modelKey` is refused
with `PERMISSION_DENIED` before a worker exists. `models.list` keeps reporting every
ready model with its `availableForSubagents` flag, which is advice to the caller and
authority only in main (#386), and D278's priority `Task.model` → definition pin →
session model is unchanged.

## Consequences

- No provider credential leaves its process boundary, and no host RPC, setting,
  schema, or Plugin SDK change is required.
- Callers omitting the field keep definition defaults and session inheritance, while
  explicit overrides require on-demand authorization and fail closed without it.
- Reversing model-selection priority stays a product decision outside this fix.
