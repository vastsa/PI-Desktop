# ADR 0289: Signed macOS GitHub Releases and in-app update delivery

- Status: Accepted
- Date: 2026-09-18
- Deciders: PI-Desktop core
- Decision: D450
- Amends: ADR 0022, ADR 0145, ADR 0191, ADR 0204, D078
- Related: D120, D126, D164, D364, ADR 0197, ADR 0232, ADR 0257, ADR 0278, E2E-196a, E2E-196c, E2E-067A

## Context

Official GitHub tag releases already produce native macOS arm64 and Intel x64
DMG/ZIP artifacts, merge `latest-mac.yml`, and ship `electron-updater`. The
default CI lane still disabled identity discovery, skipped notarization, and
kept packaged macOS on notify-and-link delivery because unsigned artifacts
cannot provide a qualified in-app upgrade.

## Decision

1. Every GitHub tag release (`vX.Y.Z`) Developer ID-signs the app through
   electron-builder 26 and notarizes it with `xcrun notarytool`
   (`-c.mac.notarize=true`).
2. The signing certificate is `Developer ID Application: XingYu Liu
   (DUV63RKYTW)`; Apple team id `DUV63RKYTW`.
3. Certificate material stays in GitHub Actions secrets: `CSC_LINK` (p12, file
   path or base64), `CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
4. Local `pnpm dist:mac` / `pnpm pack` remain unsigned when no identity is
   configured.
5. Packaged macOS uses the existing in-app `electron-updater` lane (ZIP + merged
   `latest-mac.yml` + `quitAndInstall`), same as Windows NSIS and Linux
   AppImage.
6. Do not reintroduce `afterPack` / `afterSign` adhoc codesign (ADR 0278).
   electron-builder's Developer ID pass signs the app, helpers, and the
   `pi-desktop-host-core` sidecar.
7. The unsigned first-launch note and ZIP helper remain for trusted local or
   debug unsigned builds.
8. Hardened runtime stays on.

## Consequences

- Users who download a tagged DMG should open PI-Desktop without a Gatekeeper
  “unidentified developer” or quarantine-damaged warning.
- Packaged macOS installs can check GitHub Releases, download the arch ZIP, and
  restart into the new version.
- Windows and Linux packaging, artifact names, and updater modes are unchanged.
- Operators must create the five Actions secrets before the next tag.

## Alternatives considered

- Keep unsigned tag artifacts and opt-in signing: rejected; it leaves production
  users on the Gatekeeper warning path.
- Hard-code the identity in `apps/desktop/package.json`: rejected; local
  packaging without the certificate must keep working (D078).
- Apple API key (`APPLE_API_KEY`) instead of Apple ID + app-specific password:
  deferred; the existing electron-builder 26 Apple ID path is already wired.
- Separate macOS updater implementation: rejected; reuse `electron-updater`.
