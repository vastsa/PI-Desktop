# ADR 0052: Plan operating state and approval boundary

- Status: Superseded by ADR 0053
- Date: 2026-07-30
- Baseline: `0.4.13`
- Protocol: v7
- Storage schema: v8

ADR 0053 replaces this checkpoint with immutable unique host-written
`.pi/plan/*.md` artifacts, approve/reject-only resolution, the existing
`plan_approvals` artifact/execution fields, and a startup interruption fence
with no replay. The structured proposal/request-changes details below remain
historical context for the superseded design.

## Context

PI-Desktop's former product selector treated Chat and Agent as two tool
profiles.

## Decision

The product selector is exactly `Agent | Plan`. There is one pi Agent per
session.

## Consequences

Superseded (Superseded by ADR 0053). The full record is in git history.
