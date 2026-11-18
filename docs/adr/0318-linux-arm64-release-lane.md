# ADR 0318: Publish Native Linux arm64 Artifacts

- Status: Accepted (D638)
- Date: 2026-10-01
- Related: D126, D285, D375, D603, ADR 0022, ADR 0145, ADR 0284, ADR 0292, Issue #1281

## Context

Tag releases publish Linux x64 only, and issue #1281 asks for arm64 because the
reporter runs the app inside a Linux container on an arm64 Android tablet where no
x64 artifact executes. Adding arm64 is a packaging change: the Rust `host-core`
sidecar and native voice modules are packaged from the runner's own build output,
the Linux targets pinned `arch: ["x64"]`, and the AppImage artifact name carries no
architecture.

## Decision

1. The release matrix publishes two native Linux lanes, `ubuntu-22.04` for x64 and
   GitHub's `ubuntu-22.04-arm` runner for arm64, both verifying `uname -m` and both
   keeping the documented glibc floor.
2. The static Linux targets stay AppImage, deb, and rpm without a pinned `arch`, and
   the workflow passes the matching `--x64` or `--arm64` flag, as ADR 0145 set for
   macOS.
3. `build.linux.artifactName` becomes
   `PI-Desktop-${version}-linux-${arch}.${ext}`, so each lane's AppImage carries its
   architecture.
4. Each Linux job verifies the updater feed it publishes — `latest-linux.yml` on x64
   and `latest-linux-arm64.yml` on arm64 — so both lanes' artifacts merge without one
   feed overwriting the other.
5. `scripts/export-linux-asar.mjs` takes the lane architecture, reads
   electron-builder's unpacked directory, and publishes
   `PI-Desktop-<version>-linux-<arch>.asar`.
6. `release.yml`'s `pi-host-bundle` job builds both architectures, and
   `PUBLISHED_TARGETS` lists `linux-x64` and `linux-arm64`, so an arm64 desktop can
   bootstrap an arm64 remote host (ADR 0292).
7. Updater ownership, signing, and delivery mode do not change.

## Consequences

- arm64 Linux users install native AppImage, deb, and rpm packages from every tag
  release, and the AppImage updates in place through its own feed.
- The x64 AppImage is renamed to `PI-Desktop-<version>-linux-x64.AppImage`, so
  download links carrying the old name need updating.
- Every tag release carries one arm64 `pi-host` bundle and one extra arm64 ASAR
  asset, while microphone capture stays unavailable on arm64 devices other than
  Raspberry Pi boards.

## Alternatives

- Cross-compile arm64 on the x64 runner — rejected: the sidecar and voice modules
  come from the runner's own build output.
- Pin both architectures on each Linux target — rejected: the arch list outranks the
  CLI flag, so each lane would build the other architecture around its own sidecar.
