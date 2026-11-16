# ADR 0204: Explicit Unsigned macOS First-Launch Helper

- Status: Superseded for macOS distribution by D634 /
  [ADR 0309](0309-remove-macos-first-launch-artifacts.md), as amended by D406 /
  ADR 0232, D450 / ADR 0289, and D457 / ADR 0296
- Date: 2026-09-09
- Related: D078, D371, D406, D450, D457, D634, ADR 0232, ADR 0289, ADR 0296,
  ADR 0309

## Context

Local and debug macOS packaging stays unsigned so contributors and release
operators can build without Developer ID credentials, but a trusted download can
still carry Apple's quarantine attribute, which may make Gatekeeper report that
PI-Desktop is damaged — and the existing `xattr -cr` guidance clears more than the
single attribute that causes the failure.

## Decision

1. Every macOS distribution ships an executable `PI-Desktop-macOS-open.command`
   with an opening-help note in the ZIP.
2. The helper searches only `/Applications/PI-Desktop.app` and
   `~/Applications/PI-Desktop.app`, verifies the bundle identifier is
   `net.aiuo.pi-desktop`, and expects the user to move the app there first.
3. When the verified app carries `com.apple.quarantine`, the helper recursively
   removes only that attribute and opens PI-Desktop; it never uses `sudo`, accepts
   no path argument, removes no other extended attribute, and does not claim the app
   passed Gatekeeper qualification.
4. Developer ID signing and notarization remain the release path and official tag
   releases are signed and notarized, so the helper serves trusted unsigned local or
   debug artifacts only.

## Consequences

- Users can read the documented unsigned fallback, and other extended attributes
  stay intact.
- The helper cannot repair an app installed outside the two standard directories and
  is unnecessary in signed packages.

## Alternatives

- Keep the Terminal-only `xattr -cr` instruction: not a one-click flow and it clears
  more metadata than necessary.
- Use `sudo` or an arbitrary user-selected path: expands the privilege and
  application scope of an installer workaround.
