# ADR 0232: Keep macOS DMG Opening Guidance Text-Only

- Status: Accepted
- Date: 2026-09-12
- Deciders: PI-Desktop release maintainers
- Amends: D371 / [ADR 0204](0204-unsigned-macos-first-launch-helper.md)
- Related: [E2E-196b](../spec/06-delivery/04-e2e-test-plan.md)

## Context

D371 made the unsigned macOS helper visible in every distribution, including
the DMG. The DMG's primary action is the normal app-to-Applications install,
while the fallback is needed only when a trusted unsigned app does not open.
The DMG should keep that fallback discoverable without presenting an executable
command item beside the normal installation action.

## Decision

1. The macOS DMG contains the app, the Applications link, and the opening-help
   note only. The note is displayed in Finder as `If app won't open, read this.txt` and the
   executable `PI-Desktop-macOS-open.command` is not included or exposed in the
   DMG contents.
2. The macOS ZIP package retains both `PI-Desktop-macOS-opening-help.txt` and
   the executable `PI-Desktop-macOS-open.command` at its root. The helper keeps
   D371's fixed-path, bundle-id, quarantine-only, and no-`sudo` boundaries.
3. The shared opening note leads with the narrow Terminal fallback
   `xattr -r -d com.apple.quarantine /Applications/PI-Desktop.app`, limits it
   to trusted unsigned builds, and states that signed and notarized builds do
   not need the fallback.

## Consequences

- The DMG presents a focused two-icon installation row and one clearly named
  fallback note.
- Users of the ZIP retain the one-click helper after moving the app to a
  supported Applications directory.
- DMG users with an unsigned launch failure must use the documented Terminal
  fallback; this does not widen the quarantine-clearing scope.

## Verification

`apps/desktop/test/packaging-footprint.test.mjs` asserts the DMG contents,
Chinese Finder label, absence of the command helper from that list, and the
retained ZIP helper assets. E2E-196b covers native DMG and ZIP archive
inspection on macOS.
