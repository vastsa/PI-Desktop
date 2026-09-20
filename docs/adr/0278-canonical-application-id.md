# ADR 0278: Canonical Application ID `net.aiuo.pi-desktop`

- Status: Accepted
- Date: 2026-09-17
- Deciders: PI-Desktop packaging maintainers
- Amends: D141, D371, ADR 0204
- Related: issue #524 · E2E-196b ·
  [01-product/01-product-scope](../spec/01-product/01-product-scope.md) ·
  [06-delivery/06-release-runbook](../spec/06-delivery/06-release-runbook.md)

## Context

The product advertised `com.pi-desktop.app` as the application ID, but the
owner domain is `net.aiuo.pi-desktop`. Default unsigned macOS packs also left
Electron's adhoc signature on `PI-Desktop.app` (`Identifier=Electron`,
`Info.plist=not bound`). `usernotificationsd` then required the private
`com.apple.private.usernotifications.bundle-identifiers` entitlement and
refused every request for the product bundle ID (issue #524). Adhoc signing
itself is not the defect: the identifier must equal `CFBundleIdentifier`.

## Decision

1. The canonical application ID is **`net.aiuo.pi-desktop`**. It is
   `APP_ID`, electron-builder `appId`, macOS `CFBundleIdentifier`, the
   unsigned-helper expected bundle ID, and the Windows AppUserModelID.
   Development macOS hosts use `net.aiuo.pi-desktop.dev`.
2. NSIS/AppUserModelID follow the same ID. Existing `com.pi-desktop.app`
   installs are a new identity after this cut.
3. Unsigned GitHub macOS packs do **not** re-sign the outer bundle. An
   `afterPack` adhoc `codesign` fails because nested Electron helpers are
   still unsigned (`code object is not signed at all`). Issue #524 remains
   open on the default unsigned lane until a later signed or helper-safe
   pack path.

## Consequences

- Packaged unsigned macOS artifacts keep Electron's outer identifier.
- Signed/notarized builds use Developer ID with the product bundle ID.
- Windows upgrades from a `com.pi-desktop.app` NSIS install are a new
  product identity; users may see a parallel shortcut until the old install
  is removed.

## Alternatives considered

- Keep `com.pi-desktop.app` and only re-sign: rejected because the owner
  domain is `net.aiuo.pi-desktop`.
- Change only the macOS bundle ID: rejected because D141 requires one ID
  across runtime and packaging.
- Adhoc-sign in `afterPack`/`afterSign`: rejected; nested helpers are not
  signed yet and the pack fails.
