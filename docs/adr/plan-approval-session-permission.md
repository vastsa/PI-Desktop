# Plan approval defaults to the owning Session's permission

- Status: Accepted
- Date: 2026-11-13
- Amends: ADR 0053, ADR 0158

## Context

The approval card used a device-wide remembered execution mode, falling back
to Ask independently of the Session. An Auto Session could enter Plan, approve
with the main button, and return to Agent in Ask. Conversely, another Session's
remembered Auto choice could replace an Ask Session's execution policy.

## Decision

Initialize Plan and legacy Goal approval from the proposal's owning Session's
effective permission: explicit Session mode, global default for inherit or
unavailable values, then Ask. Refresh the default when the proposal or effective
permission inputs change. Ignore and stop writing the legacy renderer-local
`pi.desktop.planApprovalMode` preference; no storage migration is required.

Keep the explicit Ask / Accept edits / Auto split-button choices. The displayed
choice remains part of the user approval request. Host validation, matching
proposal identity, artifact ownership, and the atomic approved-mode write to
the Session remain unchanged. Reject carries no permission mode.

## Alternatives and consequences

Keeping device-wide history as the default would retain cross-Session policy
changes. Changing Host resolution to ignore the submitted mode would instead
break explicit approval choices. Reading the existing Session projection fixes
the default at its UI owner without changing protocol or storage schema.

The same Session now carries its effective permission through Plan approval.
An explicit approval choice still changes that Session's permission. This does
not restore already-changed Sessions or install a new application build.
