# ADR: Plan approval defaults to the owning Session's permission

- Status: Accepted; amends ADR 0053 and ADR 0158
- Date: 2026-11-13
- Related: ADR 0053, ADR 0158

## Context

The approval card used a device-wide remembered execution mode falling back to Ask
independently of the Session, so an Auto Session could enter Plan, approve with the main
button, and return to Agent in Ask, while another Session's remembered Auto choice could
replace an Ask Session's policy.

## Decision

Plan and legacy Goal approval initialize from the owning Session's effective permission —
explicit Session mode, global default for inherit or unavailable values, then Ask —
refreshed when the proposal or the effective permission inputs change, and the legacy
renderer-local `pi.desktop.planApprovalMode` preference is ignored and no longer written.
The explicit Ask / Accept edits / Auto choices remain part of the approval request, while
Host validation, proposal identity, artifact ownership, and the atomic approved-mode write
are unchanged.

## Consequences

- The same Session carries its effective permission through Plan approval, and an explicit
  choice still changes it; already-changed Sessions are not restored.
- No storage migration is needed.

## Alternatives

- Keep device-wide history as the default: retains cross-Session policy changes.
