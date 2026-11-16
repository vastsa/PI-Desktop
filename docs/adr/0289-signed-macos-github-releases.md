# ADR 0289: Signed macOS GitHub Releases and in-app update delivery

- Status: Accepted
- Date: 2026-09-18
- Decision: D450
- Amends: ADR 0022, ADR 0145, ADR 0191, ADR 0204, D078
- Related: D120, D126, D164, D364, ADR 0197, ADR 0232, ADR 0257, ADR 0278, E2E-196a, E2E-196c, E2E-067A

## Context

Tag releases already produced native arm64 and x64 DMG/ZIP artifacts with a
merged `latest-mac.yml`, but the CI lane skipped identity discovery and
notarization, so packaged macOS stayed on notify-and-link delivery because
unsigned artifacts cannot support a qualified in-app upgrade. Local packaging
without a certificate must stay possible (D078), and contributors must not
commit certificate material, yet a Developer ID certificate for team
`DUV63RKYTW` is now available for the official release lane.

## Decision

1. Every `vX.Y.Z` tag release Developer ID-signs the app through electron-builder
   26 and notarizes it with `xcrun notarytool`, submitting the DMG separately
   because electron-builder notarizes only the app, and requiring
   `status: Accepted` before stapling and before verification of the stapled
   tickets. Only stapling and ticket validation retry, and only after Apple
   accepts the matching submission; missing secrets fail the job and unsigned
   artifacts are never published from a tag.
2. CI pins the identity as `CSC_NAME=XingYu Liu (DUV63RKYTW)`, the bare common
   name electron-builder accepts, while verification re-adds the
   `Developer ID Application:` prefix when comparing the `codesign` authority.
3. Certificate material lives only in the GitHub Actions secrets `CSC_LINK`,
   `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
   `APPLE_TEAM_ID`, and none of that set is committed, echoed, or written into
   electron-builder config.
4. Local `pnpm dist:mac` and `pnpm pack` stay unsigned without a configured
   identity, `scripts/release-macos.sh` remains the local signed lane, and
   `sign_macos: false` exists only for debug artifacts.
5. Packaged macOS uses the existing `electron-updater` lane (ZIP, merged
   `latest-mac.yml`, `quitAndInstall`) like Windows NSIS and Linux AppImage,
   while deb/rpm and Windows portable stay notify-and-link.
6. Ad-hoc `afterPack` / `afterSign` codesign is not reintroduced (ADR 0278), and
   hardened runtime stays on with the minimum entitlements: V8 JIT, unsigned
   executable memory, library-validation disable, and microphone input for the
   plugin capture permission (ADR 0257).

## Consequences

- A downloaded tagged DMG opens without a Gatekeeper unidentified-developer or
  quarantine-damaged warning.
- Packaged macOS installs update in-app; existing unsigned installs may still
  need one manual signed DMG first.
- Windows and Linux packaging and updater modes are unchanged, but operators
  must create the five Actions secrets before the next tag.

## Alternatives

- Keep unsigned tag artifacts with opt-in signing: rejected, it leaves
  production users on the Gatekeeper warning path.
- Hard-code the identity in `apps/desktop/package.json`: rejected, local
  packaging without the certificate must keep working (D078).
