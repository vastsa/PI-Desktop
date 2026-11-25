# ADR 0232: Keep macOS DMG Opening Guidance Text-Only

- Status: Superseded for macOS distribution by D634 / [ADR 0309](0309-remove-macos-first-launch-artifacts.md)
- Date: 2026-09-12
- Amends: D371 / [ADR 0204](0204-unsigned-macos-first-launch-helper.md)
- Related: [ADR 0296](0296-macos-signed-dmg-two-icon-install.md)

## Context

D371 made the unsigned macOS helper visible in every distribution, but the DMG's
primary action is the normal install to Applications, and the fallback matters
only when a trusted unsigned app does not open. The DMG needed that fallback
discoverable without an executable command item beside the normal action.

## Decision

The macOS DMG contained the app, the Applications link, and an opening-help note
shown in Finder as `If app won't open, read this.txt`, but not the executable
`PI-Desktop-macOS-open.command`. The ZIP kept both
`PI-Desktop-macOS-opening-help.txt` and `PI-Desktop-macOS-open.command` at its
root under D371's fixed-path, bundle-id, quarantine-only, and no-`sudo`
boundaries, and the shared note led with
`xattr -r -d com.apple.quarantine /Applications/PI-Desktop.app`, limited to
trusted unsigned builds.

## Superseded

D457 / ADR 0296 dropped the note from official signed DMGs, leaving the two-icon
install row alone, and D634 / ADR 0309 stopped shipping the note or the helper in
either the DMG or the ZIP. The ZIP helper provisions above are historical.
