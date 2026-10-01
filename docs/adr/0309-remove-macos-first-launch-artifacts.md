# ADR 0309: Remove bundled macOS first-launch guidance

- Status: Accepted
- Date: 2026-09-27
- Deciders: PI-Desktop release maintainers
- Amends: D457 / [ADR 0296](0296-macos-signed-dmg-two-icon-install.md), the macOS distribution provisions of [ADR 0232](0232-macos-dmg-text-only-opening-guidance.md) and [ADR 0204](0204-unsigned-macos-first-launch-helper.md)
- Related: D634, E2E-196b

## Context

The signed and notarized macOS release lane no longer needs an unsigned
first-launch workaround. The executable helper and its text note add files to
macOS packages and imply that users should bypass Gatekeeper for unsigned
builds, including local debug artifacts.

## Decision

Neither macOS DMG nor ZIP includes `PI-Desktop-macOS-open.command`,
`PI-Desktop-macOS-opening-help.txt`, or another bundled quarantine-clearing
helper or opening note. The ZIP contains `PI-Desktop.app` at its root. This
applies to signed releases and local or opt-in unsigned debug builds; signing,
notarization, stapling, and updater behavior are unchanged.

## Consequences

- Both macOS package formats omit the two first-launch guidance files.
- Unsigned debug builds do not ship a Gatekeeper workaround and must not be
  represented as equivalent to signed, notarized releases.

## Verification

`apps/desktop/test/packaging-footprint.test.mjs` guards the macOS builder
configuration against reintroducing either file. E2E-196b covers native DMG
and ZIP archive inspection.
