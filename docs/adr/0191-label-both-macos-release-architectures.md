# ADR 0191: Label Both macOS Release Architectures

- Status: Accepted
- Date: 2026-09-09
- Deciders: PI-Desktop core
- Related: D126, D285, D353, D354, ADR 0145, E2E-092

## Context

D353 added an explicit `Intel` marker to the native macOS x64 artifacts but left
Apple Silicon artifacts with electron-builder's generic version-only name. A
file such as `PI-Desktop-0.14.4.dmg` therefore still does not reveal whether it
contains arm64 or x64 code, which is ambiguous when both downloads are listed in
the same GitHub Release.

## Decision

1. Both native macOS release lanes pass target-specific artifact patterns to
electron-builder.
2. The arm64 lane publishes `PI-Desktop-<version>-arm64.dmg` and
   `PI-Desktop-<version>-arm64-mac.zip`.
3. The Intel x64 lane publishes `PI-Desktop-<version>-x64.dmg` and
   `PI-Desktop-<version>-x64-mac.zip`.
4. The convention applies to unsigned and signed macOS workflow paths. The
   generated per-architecture updater feeds retain these final asset URLs and
   checksums before the publish job merges them.
5. This changes release asset naming only; updater ownership, signing policy, and
   notify-and-link delivery remain unchanged.

## Consequences

- Users can identify the required macOS installer from its filename alone.
- DMG and ZIP names are consistent with the release matrix's `arm64` and `x64`
  values instead of using a special `Intel` label for only one lane.
- Existing generic arm64 and `-Intel` x64 asset names are not reused by future
  releases; the naming change is intentionally scoped to release artifacts.

## Alternatives considered

- Keep the arm64 name generic: rejected because it leaves one of the two
  architectures ambiguous.
- Use `Intel` for x64 and `Apple-Silicon` for arm64: rejected because the release
  matrix and Electron target use standard architecture identifiers, which are
  shorter and easier to match to the actual package contents.
