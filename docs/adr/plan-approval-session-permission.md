# ADR: Plan approval defaults to the owning Session's permission

- Status: Accepted
- Date: 2026-11-13
- Amends: ADR 0053, ADR 0158

## Context

The approval card used a device-wide remembered execution mode, falling back to
Ask independently of the Session. An Auto Session could enter Plan, approve with
the main button, and return to Agent in Ask.

## Decision

Initialize Plan and legacy Goal approval from the proposal's owning Session's
effective permission: explicit Session mode, global default for inherit or
unavailable values, then Ask. Refresh the default when the proposal or effective
permission inputs change.

Keep the explicit Ask / Accept edits / Auto split-button choices. The displayed
choice remains part of the user approval request.

## Alternatives

Keeping device-wide history as the default would retain cross-Session policy
changes.

## Consequences

The same Session now carries its effective permission through Plan approval.
