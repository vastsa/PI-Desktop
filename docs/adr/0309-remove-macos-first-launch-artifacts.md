# ADR 0309: Remove bundled macOS first-launch guidance

- Status: Accepted
- Date: 2026-09-27
- Amends: D457 / [ADR 0296](0296-macos-signed-dmg-two-icon-install.md), the macOS
  distribution provisions of [ADR 0232](0232-macos-dmg-text-only-opening-guidance.md)
  and [ADR 0204](0204-unsigned-macos-first-launch-helper.md)
- Related: D634, E2E-196b

## Context

The signed and notarized macOS lane no longer needs an unsigned first-launch
workaround, and the bundled helper and text note imply that users should bypass
Gatekeeper.

## Decision

Neither the macOS DMG nor the ZIP includes `PI-Desktop-macOS-open.command`,
`PI-Desktop-macOS-opening-help.txt`, or any other quarantine-clearing helper or
opening note, and the ZIP contains `PI-Desktop.app` at its root. Signing,
notarization, stapling, and updater behavior stay unchanged.

## Consequences

- Both macOS package formats omit the two first-launch guidance files.
- Unsigned debug builds ship no Gatekeeper workaround and are not equivalent to
  signed releases.
