# ADR 0221: Render Canonical Thinking-Level Values Without Translation

- Status: Accepted; amends D369 and ADR 0202
- Date: 2026-09-11
- Related: D369, ADR 0202

## Context

Thinking levels are protocol values shared by provider bindings, session
configuration, runtime results, and model metadata, yet the renderer translated them
in the Composer, model configuration, and delegation cards, so a stable technical
value varied with the applied locale.

## Decision

Composer, model-configuration, and delegation surfaces render the canonical values
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` as-is: they are not
locale catalog entries, their localized labels are removed from every shipped
catalog, and `off` and `omit` remain omitted from delegation captions per ADR 0202.
This changes presentation only; effective metadata, clamping, provider requests,
protocol, and storage are unchanged.

## Consequences

Users see the same unambiguous value in every locale, comparable with configuration
and diagnostics, and the lower-case values keep their canonical wire and storage
representation.
