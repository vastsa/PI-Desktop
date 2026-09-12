# ADR 0204: Explicit Unsigned macOS First-Launch Helper

- Status: Accepted (amended by D406 / ADR 0232)
- Date: 2026-09-09
- Deciders: PI-Desktop core
- Related: D078, D371, D406, E2E-196b

## Context

The default macOS distribution lane remains unsigned so contributors and
release operators can build without Developer ID credentials. A trusted
download of that artifact can still carry Apple's quarantine attribute, which
may make Gatekeeper report that PI-Desktop is damaged. The existing guidance
required users to open Terminal and run `xattr -cr`, which is broader than the
single attribute that causes this launch failure.

## Decision

1. Every macOS distribution includes an executable
   `PI-Desktop-macOS-open.command` alongside the opening-help note. The DMG
   places the helper in a visible first-launch row below the install gesture.
2. The helper searches only `/Applications/PI-Desktop.app` and
   `~/Applications/PI-Desktop.app`. It verifies the bundle identifier is
   `com.pi-desktop.app`, and the user must move the app into one of those
   directories before running it.
3. When the verified app carries `com.apple.quarantine`, the helper recursively
   removes only that attribute and then opens PI-Desktop. It never uses `sudo`,
   accepts no arbitrary path argument, removes no other extended attribute, and
   does not claim that an unsigned app passed Gatekeeper qualification.
4. The DMG labels the package as unsigned and the note continues to state that
   signed and notarized builds do not need the helper.
5. Developer ID signing and notarization remain the release path for normal
   Gatekeeper launches; this helper is an explicit user action for trusted
   unsigned artifacts, not a replacement for signing.

## Consequences

- A user can read the documented unsigned first-launch fallback from the DMG;
  the ZIP retains the one-Finder-double-click helper after the normal
  drag-to-Applications step.
- Other extended attributes remain intact, reducing the scope of the
  quarantine workaround.
- The helper cannot repair an app installed outside the two standard
  Applications directories; the opening note provides the supported Terminal
  fallback for `/Applications`.
- The same helper is harmless in signed packages but is not needed there.

## Amendment (D406 / ADR 0232)

The DMG-specific helper placement is replaced. DMGs now expose only the
opening-help note, displayed as `If app won't open, read this.txt`; the executable helper
remains in the macOS ZIP package. The note is the DMG fallback and no longer
describes a helper that is present in the DMG.

## Alternatives considered

- Keep the Terminal-only `xattr -cr` instruction: rejected because it is not a
  one-click flow and clears more metadata than necessary.
- Use `sudo` or target a user-selected arbitrary path: rejected because it
  would expand the privilege and application scope of an installer workaround.
- Require signing for every local build: rejected because D078 intentionally
  keeps local packaging available without Developer ID credentials.
