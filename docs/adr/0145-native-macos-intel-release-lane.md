# ADR 0145: Publish Native macOS Intel Artifacts

- Status: Accepted (amended by D353, ADR 0191, D450 / ADR 0289)
- Date: 2026-09-01
- Related: ADR 0022, ADR 0191, ADR 0289, D126, D285, D353, D354, D450

## Context

Tag releases published only Apple Silicon macOS artifacts, and the shared
electron-builder configuration pinned both macOS targets to `arm64`. The Rust host
sidecar is packaged from the native `target/release` output, so a cross-compiled
Electron package is unsafe unless the sidecar architecture is managed and
verified independently.

## Decision

The release matrix publishes two native macOS lanes, `macos-15` for arm64 and
`macos-15-intel` for x64, each verifying `uname -m` and building
`pi-desktop-host-core` locally before packaging that same output. Static macOS
targets stay DMG and ZIP without a fixed `arch`, and the workflow passes an
explicit `--arm64` or `--x64` flag; the local signed release script defaults to the
host architecture and rejects a mismatching `MAC_ARCH`. Each job renames its
generated `latest-mac.yml` before upload and the publish job validates and merges
both feeds into one `latest-mac.yml` published next to both installers. D353's
`-Intel` suffix convention is superseded by ADR 0191: both lanes use their standard
`-arm64` and `-x64` labels, with updater URLs and checksums generated from the
final names. Updater ownership is untouched; D450 / ADR 0289 now drives in-app
macOS updates from the merged feed.

## Consequences

- Intel Mac users receive native DMG and ZIP artifacts from every tag release.
- Host and Electron architectures match deterministically on both lanes, and every
  public download carries an explicit architecture marker.
- Publication needs one metadata merge step, and cross-building the other
  architecture requires the matching native runner.

## Alternatives

- Keep macOS arm64-only: rejected because Intel users still cannot install a
  native release.
- Build Intel packages on Apple Silicon: rejected because the Rust sidecar comes
  from the host's native target and could mismatch the Electron package.
