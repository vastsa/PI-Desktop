# ADR 0278: Canonical Application ID `net.aiuo.pi-desktop`

- Status: Accepted
- Date: 2026-09-17
- Amends: D141, D371, ADR 0204
- Related: Issue #524 · E2E-196b

## Context

The product advertised `com.pi-desktop.app` although the owner domain is
`net.aiuo.pi-desktop`, and default unsigned macOS packs left Electron's adhoc
signature on `PI-Desktop.app`, so `usernotificationsd` refused every request for the
product bundle ID (issue #524). Adhoc signing itself is not the defect: the identifier
must equal `CFBundleIdentifier`.

## Decision

1. The canonical application ID is **`net.aiuo.pi-desktop`**, used as `APP_ID`,
   electron-builder `appId`, macOS `CFBundleIdentifier`, the unsigned-helper bundle
   ID, and the Windows AppUserModelID, with `net.aiuo.pi-desktop.dev` on development
   macOS hosts.
2. NSIS and AppUserModelID follow the same ID, so existing `com.pi-desktop.app`
   installs become a new identity.
3. Unsigned GitHub macOS packs do not re-sign the outer bundle, because an `afterPack`
   adhoc `codesign` fails while nested helpers are unsigned; issue #524 stays open on
   that lane.

## Consequences

- Unsigned macOS artifacts keep Electron's outer identifier, while signed builds use
  Developer ID with the product bundle ID.
- Windows upgrades from a `com.pi-desktop.app` install appear as a new product
  identity, possibly with a parallel shortcut.

## Alternatives

- Keep `com.pi-desktop.app` and only re-sign — rejected: the owner domain is
  `net.aiuo.pi-desktop`.
