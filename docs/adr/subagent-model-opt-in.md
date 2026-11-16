# ADR: Separate Subagent Model Opt-In from Definition Pins

- Status: Accepted for implementation
- Date: 2026-09-13
- Related: D278, ADR 0062, ADR 0089, ADR 0237, E2E-166, issues #286, #386

## Context

Electron resolves definition pins and automatically selectable models into one
credential-bearing `subagentProviders` map. Treating every map key as a
`Task.model` selection both advertises private pins and bypasses main's
`availableForSubagents` check on the on-demand path.

## Decision

Add an optional `subagentModelKeys: string[]` field to the internal Electron-to-
sidecar launch payload, runtime options, and reuse comparison. Main includes
only successfully resolved bindings independently marked `availableForSubagents`
on enabled providers.

The runtime uses the separate keys for its model summary. Missing keys mean no
cached override authorization.

## Consequences

- No provider credential leaves its existing process boundary.
- Older callers that omit the additive field retain definition defaults and
  session inheritance.
- Runtime, model transport, and launch wiring regression coverage prove the
  boundary.
- Reversing model-selection priority is a product decision outside this fix.
