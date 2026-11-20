# ADR: Fork release coordinates and unsigned macOS builds

- Status: Accepted
- Date: 2026-11-20
- Related: D686, ADR 0022, ADR 0289, ADR 0327

## Context

This repository is a fork of `vastsa/PI-Desktop`. Work planned for the fork adds
a capability to the headless `pi-host`, and a paired remote host is installed
from the GitHub Release of the repository the desktop names, at the desktop's
own version. Upstream bundles will not carry that capability, so the fork has
to publish its own desktop builds and host bundles.

The release workflow required upstream's Developer ID secrets on every tag and
built five desktop lanes. The fork has no Apple Developer ID certificate and
ships the desktop for macOS arm64 only.

## Decision

1. `GITHUB_REPO` in `packages/shared` is `david-yang-pixel/PI-Desktop`. It
   drives the `pi-host` bundle URLs and the feedback issue link, and the
   updater's releases page derives from it. The electron-updater feed
   configuration names the same repository.
2. The plugin marketplace catalog, the documentation site, and both READMEs
   keep pointing at upstream.
3. A tag builds the desktop for macOS arm64 only, unsigned, unless the
   repository variable `MACOS_SIGN_RELEASE` is `true`. The upstream signed,
   notarized, and stapled lane stays in the workflow unchanged and dormant.
4. An unsigned package is stamped `piDistribution: "unsigned"` and ad-hoc
   signed so its bundle seal is valid. A build that carries the marker never
   supports automatic updates, so it always uses manual delivery, whatever
   preference the profile stores. The release workflow verifies the marker
   and the seal on the packaged artifact.
5. The `pi-host` bundle job keeps building Linux x64 and arm64. It follows the
   targets the desktop can install, not the desktop's own build matrix.
6. Upstream's issue automation, which needs upstream's model API secret, runs
   only in the upstream repository.

## Consequences

- macOS users of the fork update by downloading a new build. The first launch
  needs a manual allow, because the build is not notarized.
- The signed lane, its scripts, and the tests that pin upstream's signing
  identity remain in the tree unused.
- The release matrix differs from upstream, so merges of that workflow block
  will conflict and must keep the fork's single row.
- Feedback issues opened from the app land on the fork.

## Alternatives

- Parameterize the Apple team identity so the fork could sign later: rejected.
  No certificate exists, and it would rewrite three scripts and three test
  files for no user while widening every future merge from upstream.
- A second repository constant for feedback links only: rejected. Reports about
  a fork build belong on the fork.
- Keep the upstream coordinates and install hosts from a locally built bundle:
  rejected. Automatic host realignment downloads from the release repository,
  so every paired host would stay on upstream's bundle.
