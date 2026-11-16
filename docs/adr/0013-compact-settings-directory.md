# ADR 0013: Consolidate settings navigation into four destinations

- Status: Superseded in part by ADR 0026
- Date: 2026-07-26

## Context

Baseline 0.4.0 froze the broad Codex-aligned settings rail in D062–D065. That
directory exposed Personal, Integrations, and Coding groups containing
standalone Appearance and Providers destinations plus numerous placeholder rows.

## Decision

Keep the full-page settings shell, Back to app action, search control, rail
metrics, content cards, and theme behavior from D063/D070.

Replace the broad grouped directory with exactly four destinations in this
order:

1. General
2. Configuration
3. Import sessions
4. About

## Consequences

- The settings rail is shorter and contains only implemented, useful
  destinations.
- Theme controls remain discoverable under General.
- Provider management remains reachable from model setup flows without consuming
  another rail row.
- Plugin management remains reachable from the app shell without duplicating it
  in Settings.
- The full-page shell and established light/dark visual metrics do not change.

## Alternatives

### Keep the broad Codex directory

Rejected because empty and low-value destinations obscure the implemented local
workflows.

### Remove Appearance or Providers entirely

Rejected because theme selection and provider configuration are required product
capabilities; consolidation preserves them without separate destinations.

## References

- `docs/spec/00-baseline.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D090)
