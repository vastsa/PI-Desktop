# ADR 0191: Label Both macOS Release Architectures

- Status: Accepted (amended by D450 / ADR 0289: architecture-labelled ZIPs stay the
  in-app updater payloads and official tag artifacts are signed and notarized)
- Date: 2026-09-09
- Related: D126, D285, D353, D354, D450, ADR 0145, ADR 0289

## Context

D353 marked native macOS x64 artifacts `Intel` but left Apple Silicon artifacts with
electron-builder's generic version-only name, so a file such as
`PI-Desktop-0.14.4.dmg` never says whether it contains arm64 or x64 code when both
downloads sit in the same release.

## Decision

1. Both native macOS release lanes pass target-specific artifact patterns to
   electron-builder.
2. The arm64 lane publishes `PI-Desktop-<version>-arm64.dmg` and `-arm64-mac.zip`,
   and the Intel x64 lane publishes the matching `-x64.dmg` and `-x64-mac.zip`
   names.
3. The convention covers unsigned and signed workflow paths, and the generated
   per-architecture updater feeds retain these asset URLs and checksums before the
   publish job merges them.

## Consequences

- Users can identify the required installer from its filename alone, and DMG and
  ZIP names match the release matrix's `arm64` and `x64` values.
- Existing generic arm64 and `-Intel` x64 names are not reused by future releases.

## Alternatives

- Keep the arm64 name generic: leaves one of the two architectures ambiguous.
- Use `Intel` and `Apple-Silicon`: the release matrix and Electron target use the
  standard architecture identifiers.
