# ADR 0221: Render Canonical Thinking-Level Values Without Translation

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop desktop UI maintainers
- Amends: D369, ADR 0202
- Related: [02-i18n-english-first](../spec/04-ux/02-i18n-english-first.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) · E2E-219

## Context

Thinking levels are protocol values shared by provider bindings, session
configuration, runtime results, and model metadata. The renderer translated the
same values in the Composer, model configuration, and delegation cards, which
made a stable technical value vary with the selected application locale.

## Decision

1. Composer, model-configuration, and delegation surfaces render the canonical
   values `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` as-is.
2. The thinking-level values are not locale catalog entries.
3. `off` and `omit` remain omitted from delegation captions as specified by ADR
   0202.

## Consequences

Users see the same unambiguous value in every locale, and provider/runtime
terminology remains easy to compare with configuration and diagnostics.
