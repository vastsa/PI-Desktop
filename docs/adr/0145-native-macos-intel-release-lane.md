# ADR 0145: Publish Native macOS Intel Artifacts

- Status: Accepted
- Date: 2026-09-01
- Deciders: PI-Desktop core
- Related: D126, D285, ADR 0022, E2E-092

## Context

The tag release workflow published only Apple Silicon macOS artifacts. The
electron-builder configuration also pinned both macOS targets to `arm64`, so
an Intel build could not be selected without changing the shared package
configuration. The Rust host sidecar is packaged from the native
`target/release` output, which makes a cross-compiled Electron package unsafe
unless the sidecar architecture is independently managed and verified.

## Decision

1. The release matrix publishes two native macOS lanes: `macos-15` for arm64
   and `macos-15-intel` for x64. The workflow verifies `uname -m` before
   preparing package inputs.
2. The static macOS electron-builder targets remain DMG and ZIP without a
   fixed `arch`. The workflow passes the explicit matching `--arm64` or
   `--x64` flag to electron-builder.
3. Each macOS runner builds `pi-desktop-host-core` locally and packages that
   same native output. The local signed release script defaults to the host
   architecture and rejects a `MAC_ARCH` override that does not match it.
4. Each macOS job renames its generated `latest-mac.yml` before uploading. The
   publish job validates both feeds, merges their files, and publishes one
   combined `latest-mac.yml` alongside both architectures' installers.
5. macOS update behavior remains notify-and-link until a signed in-app channel
   is qualified. This decision changes release artifact coverage and native
   packaging only; it does not change updater ownership or signing policy.

## Consequences

- Intel Mac users receive native DMG and ZIP artifacts from every tag release.
- The Rust host and Electron executable have a deterministic, matching
  architecture on both macOS lanes.
- Release publication needs one metadata merge step because electron-builder
  emits one macOS updater feed per architecture.
- Intel package footprint and native launch qualification must be recorded
  separately from the existing arm64 baseline.
- A developer cannot use the signed local lane to cross-build the other macOS
  architecture without first moving to the matching native runner.

## Alternatives considered

- Keep macOS arm64-only: rejected because Intel users remain unable to install
  a native release and the requested platform coverage is not met.
- Build Intel packages on an Apple Silicon runner: rejected because the Rust
  sidecar is produced from the host's native release target and could be
  mismatched with the Electron package.
- Publish separate updater feeds permanently: rejected because the current
  macOS delivery mode is notify-and-link and the GitHub Release should expose
  one macOS feed when a signed update channel becomes available.
