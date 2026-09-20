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
cannot provide a qualified in-app upgrade. Local packaging without a
certificate must stay possible (D078). Contributors must not commit
certificate material.

A Developer ID Application certificate for team `DUV63RKYTW` is now available
for the official `vastsa/PI-Desktop` release lane.

## Decision

1. Every GitHub tag release (`vX.Y.Z`) Developer ID-signs the app through
   electron-builder 26 and notarizes it with `xcrun notarytool`
   (`-c.mac.notarize=true`). Because electron-builder notarizes only the app,
   the final DMG is submitted separately (`xcrun notarytool submit --wait`) and
   must return `status: Accepted` before `xcrun stapler staple` may run; the
   run then verifies the app as `Notarized Developer ID` and both stapled
   tickets before upload. Stapler retries are bounded and only allowed after
   Apple accepts. Missing signing or notarization secrets fail the job;
   unsigned macOS artifacts must not be published from a tag.
2. The signing certificate is
   `Developer ID Application: XingYu Liu (DUV63RKYTW)`; Apple team id
   `DUV63RKYTW`. CI pins it with `CSC_NAME=XingYu Liu (DUV63RKYTW)`. The name
   must be the bare common name: electron-builder 26 rejects an identity that
   keeps the `Developer ID Application:` prefix, and the verification step
   re-adds that prefix when it compares the `codesign` authority.
3. Certificate material stays in GitHub Actions secrets:
   `CSC_LINK` (p12, file path or base64), `CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Nothing of that set is
   committed, echoed, or written into electron-builder config.
4. Local `pnpm dist:mac` / `pnpm pack` remain unsigned when no identity is
   configured. `scripts/release-macos.sh` remains the local signed lane.
   `workflow_dispatch` may set `sign_macos: false` only to produce unsigned
   debug artifacts; that path must not be used for a GitHub Release tag.
5. Packaged macOS uses the existing in-app `electron-updater` lane (ZIP +
   merged `latest-mac.yml` + `quitAndInstall`), same as Windows NSIS and
   Linux AppImage. Linux deb/rpm and Windows portable stay notify-and-link.
   Renderer IPC, feed ownership, `allowPrerelease = false`, and auto-check
   timing are unchanged.
6. Do not reintroduce `afterPack` / `afterSign` adhoc codesign (ADR 0278).
   electron-builder's Developer ID pass signs the app, helpers, and the
   `pi-desktop-host-core` sidecar.
7. The unsigned first-launch note and ZIP helper remain for trusted local or
   debug unsigned builds. Official GitHub Release DMGs are signed and
   notarized and must not claim otherwise.
8. Hardened runtime stays on. Entitlements stay the minimum required set:
   V8 JIT, unsigned executable memory, library-validation disable (Electron
   helpers and plugin-loaded native addons), and microphone input for the
   existing plugin capture permission (ADR 0257), with
   `NSMicrophoneUsageDescription` in Info.plist.

## Consequences

- Users who download a tagged DMG should open PI-Desktop without a
  Gatekeeper “unidentified developer” or quarantine-damaged warning.
- Packaged macOS installs can check GitHub Releases, download the arch ZIP,
  and restart into the new version. Existing unsigned installs may still need
  one manual signed DMG before in-app updates succeed.
- Windows and Linux packaging, artifact names, and updater modes are
  unchanged.
- Operators must create the five Actions secrets before the next tag.

## Alternatives considered

- Keep unsigned tag artifacts and opt-in signing: rejected; it leaves
  production users on the Gatekeeper warning path.
- Hard-code the identity in `apps/desktop/package.json`: rejected; local
  packaging without the certificate must keep working (D078).
- Apple API key (`APPLE_API_KEY`) instead of Apple ID + app-specific
  password: deferred; the existing electron-builder 26 Apple ID path is
  already wired.
- Separate macOS updater implementation: rejected; reuse `electron-updater`.
