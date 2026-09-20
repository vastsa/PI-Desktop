# ADR: Remember explicit Composer model and reasoning choices

- Status: Accepted
- Date: 2026-09-20
- Amends: ADR 0114, ADR 0295 (desktop creation defaults only)
- Related: Issue #678; E2E-COMPOSER-remember-model-and-thinking

## Context

New desktop conversations snapshot global defaults even after the user chooses
a different model or reasoning level in the Composer. Repeating that selection
adds friction. Copying an arbitrary viewed conversation would instead turn
history navigation into an unexpected preference change.

## Decision

Remember explicit Composer model/reasoning actions as a device preference,
following existing renderer-local approval and sidebar preference ownership.
The versioned localStorage value contains at most 100 provider/model/level
triples, most recently chosen first. Validate stored input and currently usable
provider/model identities on consumption. New session and empty-home display
share one resolver: explicit draft, then last usable choice, then Settings.
Restore thinking per provider/model and clamp against current capabilities.

Only the model menu opts into recording through the renderer configuration
action; rejected writes, navigation, legacy model pinning, permissions, forks,
and background callers do not record. Accepted next-turn staging does record
user intent, even if the eventual host flush fails. A monotonic action intent
prevents an older successful write from superseding a newer selection.

## Consequences

- Updating global defaults on every selection would overwrite an explicit
  fallback and add host persistence writes; keep those Settings unchanged.
- Copying the viewed session would confuse browsing with selection and might
  propagate Auto permissions. Permissions and operating mode remain unchanged.
- Host-synchronized preferences would add a cross-process contract for a device
  interaction preference. No host API, SQLite schema, or migration changes are
  needed. The selected session configuration remains host-owned and durable.
- Blocked/full/corrupt browser storage falls back to existing defaults. These
  preferences are device/profile-local, not synchronized across devices.
