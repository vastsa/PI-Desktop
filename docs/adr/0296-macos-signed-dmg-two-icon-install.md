# ADR 0296: Signed macOS DMG is a two-icon install

- Status: Accepted; ZIP guidance superseded by D634 / [ADR 0309](0309-remove-macos-first-launch-artifacts.md)
- Date: 2026-09-19
- Deciders: PI-Desktop release maintainers
- Amends: [ADR 0232](0232-macos-dmg-text-only-opening-guidance.md), [ADR 0204](0204-unsigned-macos-first-launch-helper.md)
- Related: D457, D450, D634 / [ADR 0289](0289-signed-macos-github-releases.md), [ADR 0309](0309-remove-macos-first-launch-artifacts.md), E2E-196b, E2E-196c

## Context

Official GitHub Release DMGs are Developer ID-signed and notarized (ADR 0289), yet
they still showed the unsigned first-launch note from ADR 0232, which is no longer
the install path for tagged builds and made the installer look like an error dialog.

## Decision

1. The macOS DMG contains only `PI-Desktop.app` and the Applications link on a
   branded dark plate: no opening-help note and no
   `PI-Desktop-macOS-open.command`.
2. *(D634 / ADR 0309)* The ZIP ships neither artifact, and no other bundled
   quarantine-clearing helper, in signed releases and unsigned local or debug builds
   alike.
3. The DMG artwork is generated from the canonical app icon by
   `scripts/make-dmg-background.py`; the PNG pair is never hand-edited.

## Consequences

A tagged artifact installs with one drag-to-Applications gesture, unsigned local
builds fall back to the documented `xattr` command, and the plate caption stays
English with a quiet Chinese line.
