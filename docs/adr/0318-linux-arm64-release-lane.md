# ADR 0318: Publish Native Linux arm64 Artifacts

- Status: Accepted (D638)
- Date: 2026-10-01
- Deciders: PI-Desktop core
- Related: D126, D285, D375, D603, ADR 0022, ADR 0145, ADR 0284, ADR 0292, issue #1281, E2E-192a

## Context

Tag releases publish Linux x64 only. Issue #1281 asks for a Linux arm64 build:
the reporter runs PI-Desktop inside a Linux container on a rooted arm64 Android
tablet, where no x64 artifact can execute and emulation is not a usable path for
an Electron app.

Three properties of the existing lane make "add arm64" a packaging change rather
than a new flag on one job:

1. The Rust `pi-desktop-host-core` sidecar and the native voice modules are
   packaged from the runner's own build output. A cross-built arm64 package on
   the x64 runner would ship an x64 sidecar inside an arm64 app.
2. The Linux electron-builder targets pinned `arch: ["x64"]`, and
   electron-builder prefers a target's configured arch list over the CLI
   `--x64` / `--arm64` flag. Pinning both architectures would make each Linux
   lane build the other architecture around its own native sidecar.
3. The AppImage target's default artifact name carries no architecture, so two
   Linux lanes would publish the same `PI-Desktop-<version>.AppImage` file name
   and the publish job's merged download would keep only whichever lane arrived
   last.

`electron-updater` resolves its Linux feed by architecture: `latest-linux.yml`
on x64 and `latest-linux-<arch>.yml` on every other architecture
(`Provider.getChannelFilePrefix`).

## Decision

1. The release matrix publishes two native Linux lanes: `ubuntu-22.04` for x64
   and GitHub's arm64 `ubuntu-22.04-arm` runner for arm64. Both verify
   `uname -m` (`x86_64` / `aarch64`) before preparing package inputs, exactly as
   the macOS lanes verify their native runner. Both images are Ubuntu 22.04, so
   both keep the documented glibc 2.35 floor.
2. The static Linux targets stay AppImage, deb, and rpm without a pinned `arch`.
   The workflow passes the matching `--x64` or `--arm64` flag to
   electron-builder, which is the same rule ADR 0145 set for macOS.
3. `build.linux.artifactName` becomes
   `PI-Desktop-${version}-linux-${arch}.${ext}`, so the AppImage assets are
   `PI-Desktop-<version>-linux-x64.AppImage` and
   `PI-Desktop-<version>-linux-arm64.AppImage`. The deb and rpm targets keep
   their own patterns and expand `${arch}` through FPM's arch names
   (`amd64`/`arm64` and `x86_64`/`aarch64`).
4. Each Linux job verifies the updater feed it is about to publish —
   `latest-linux.yml` on x64, `latest-linux-arm64.yml` on arm64. electron-builder
   already writes that architecture-suffixed name
   (`getArchPrefixForUpdateFile`), so no rename is needed and the publish job
   merges both lanes' artifacts without one feed overwriting the other.
5. `scripts/export-linux-asar.mjs` takes the lane architecture, reads the
   archive from electron-builder's own unpacked directory
   (`linux-unpacked` for x64, `linux-arm64-unpacked` for arm64), and publishes
   `PI-Desktop-<version>-linux-<arch>.asar`.
6. `release.yml`'s `pi-host-bundle` job builds both Linux architectures, and
   `PUBLISHED_TARGETS` in `apps/desktop/electron/main/remote/pi-host-release.ts`
   lists `linux-x64` and `linux-arm64`. An arm64 desktop can therefore
   bootstrap an arm64 remote host over SSH (ADR 0292) instead of refusing a
   target the release already serves.
7. No updater ownership, signing, or delivery-mode change: the arm64 AppImage
   uses the same in-app `electron-updater` lane as x64, and deb/rpm stay
   notify-and-link.

## Consequences

- arm64 Linux users install native AppImage, deb, and rpm packages from every
  tag release, and the AppImage updates in place through its own feed.
- The x64 AppImage asset is renamed from `PI-Desktop-<version>.AppImage` to
  `PI-Desktop-<version>-linux-x64.AppImage`. Download links that carry the old
  name must be updated; in-app updates are unaffected because the updater reads
  the published feed rather than a hard-coded file name.
- Every tag release carries one `pi-host-<version>-linux-arm64.tar.gz` bundle
  and one extra arm64 system-Electron ASAR asset beside the existing x64 ones.
- Microphone capture stays unavailable on arm64 Linux devices other than
  Raspberry Pi boards: `@picovoice/pvrecorder-node` classifies Linux arm64 by
  `/proc/cpuinfo` CPU part and only knows Raspberry Pi parts. Speech-to-text
  (`transcribe-cpp` ships a `linux-arm64-cpu-vulkan` bundle) and every other
  feature have no architecture-specific dependency.
- Release cost grows by one Linux packaging job and one pi-host bundle job.

## Alternatives considered

- **Cross-compile the arm64 packages on the existing x64 runner.** Rejected: the
  packaged Rust sidecar and the native voice modules come from the runner's own
  build output, so a cross-compiled lane needs a second toolchain and a
  separate architecture verification to stay honest.
- **Emulate arm64 on the x64 runner.** Rejected: an emulated build both hides
  architecture mistakes and turns a bounded packaging job into a long one.
- **Ship only the AppImage for arm64.** Rejected: deb and rpm are the formats
  arm64 Linux distributions install, and FPM publishes a native linux-arm64
  build, so the lane costs nothing extra.
- **Keep Linux x64 only.** Rejected: the request is a supported platform that
  cannot run the published artifact at all.
- **Pin both architectures on each Linux target.** Rejected: electron-builder's
  configured arch list outranks the CLI flag, so each lane would build its
  non-native architecture around its own sidecar.
