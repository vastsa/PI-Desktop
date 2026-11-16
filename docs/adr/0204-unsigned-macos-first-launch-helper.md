# ADR 0204: Explicit Unsigned macOS First-Launch Helper

- Status: Superseded for macOS distribution by D634 / [ADR 0309](0309-remove-macos-first-launch-artifacts.md)
- Date: 2026-09-09
- Deciders: PI-Desktop core
- Related: D078, D371, D406, D450, D457, D634, E2E-196b, ADR 0289, ADR 0296, ADR 0309

## Context

Local and debug macOS packaging remain unsigned so contributors and release
operators can build without Developer ID credentials. A trusted download of that
artifact can still carry Apple's quarantine attribute, which may make Gatekeeper
report that PI-Desktop is damaged.

## Decision

1. Every macOS distribution includes an executable
   `PI-Desktop-macOS-open.command` alongside the opening-help note.
2. The helper searches only `/Applications/PI-Desktop.app` and
   `~/Applications/PI-Desktop.app`.
3. When the verified app carries `com.apple.quarantine`, the helper recursively
   removes only that attribute and then opens PI-Desktop.
4. The DMG labels the package as unsigned and the note continues to state that
   signed and notarized builds do not need the helper.
5. Developer ID signing and notarization remain the release path for normal
   Gatekeeper launches; this helper is an explicit user action for trusted
   unsigned artifacts, not a replacement for signing.

## Consequences

- A user can read the documented unsigned first-launch fallback from the DMG;
  the ZIP retains the one-Finder-double-click helper after the normal
  drag-to-Applications step.
- Other extended attributes remain intact, reducing the scope of the quarantine
  workaround.
- The helper cannot repair an app installed outside the two standard
  Applications directories; the opening note provides the supported Terminal
  fallback for `/Applications`.
- The same helper is harmless in signed packages but is not needed there.

## Amendment (D406 / ADR 0232)

The DMG-specific helper placement is replaced. DMGs now expose only the
opening-help note, displayed as `If app won't open, read this.txt`; the
executable helper remains in the macOS ZIP package.

## Alternatives considered

- Keep the Terminal-only `xattr -cr` instruction: rejected because it is not a
  one-click flow and clears more metadata than necessary.
- Use `sudo` or target a user-selected arbitrary path: rejected because it would
  expand the privilege and application scope of an installer workaround.
- Require signing for every local build: rejected because D078 intentionally
  keeps local packaging available without Developer ID credentials.

## Amendment (D450 / ADR 0289)

Official GitHub tag releases are Developer ID-signed and notarized. The
first-launch helper and opening note remain for trusted unsigned local or debug
artifacts only.

## Amendment (D457 / ADR 0296)

The DMG no longer shows the opening-help note. ZIP retains the helper and note
for trusted unsigned local or debug artifacts.
