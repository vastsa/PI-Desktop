# ADR 0102: Publisher-owned plugin source with a Git-hosted artifact store

- Status: Accepted for implementation (supersedes ADR 0006, amends ADR 0005 and
  ADR 0007; amended 2026-08-19 so artifacts are committed to the existing
  distribution repository instead of published as releases of the center
  repository, with the ownership model unchanged)
- Date: 2026-08-18
- Related: ADR 0005, ADR 0006, ADR 0007, ADR 0008

## Context

The shipped marketplace stores everything in one repository:
`vastsa/pi-desktop-plugins` holds plugin source under `plugins/<id>/`, built
packages under `packages/*.piplug`, and the `catalog.json` the client reads, so
publishing means a maintainer commits somebody else's source and regenerates the
catalog with a local script. That model does not survive third-party publishers:
plugin source has no owner outside the marketplace repository, the repository
grows binary packages forever, nothing binds a published package to the source
that produced it, `verified` is a hand-edited catalog field, and `download_url`
follows redirects to any host.

## Decision

### 1. The publisher's repository is the source of truth

A publisher submits a repository coordinate — canonical HTTPS repository URL,
path, and a ref that resolves to a 40-hex commit — and PI-Desktop never copies
plugin source into a project-owned repository, with `pluginId`, `publisherId`, the
linked repository, and the packaged `manifest.json` identity agreeing and each
published version pinned to exactly one `(repository, commit, path)` tuple.

### 2. Management and distribution are separate repositories

`vastsa/pi-plugin-center` is the management plane — submissions, ownership
verification, isolated builds, review, the policy gate, and the registry of what
has been published — while `vastsa/pi-desktop-plugins` stays the distribution
repository serving `catalog.json` from its root and packages from `packages/`,
mirrored on CNB, with no S3, R2, or separately operated CDN.

The publisher attaches `<id>-<version>.piplug` to a release in their own
repository or the center's isolated runner builds it from the pinned commit, and
the center verifies the bytes and commits the package with a regenerated
`catalog.json` in one commit; package URLs stay relative, so switching between
GitHub and the CNB mirror cannot send a download to the other provider or change
the checksum being verified.

### 3. Catalog schema v2 is the client contract

`catalog.json` gains `schemaVersion: 2` and carries, per version, the source
repository, ref, commit and path, the builder identity, the review decision, risk
tier and policy version, `yanked` state, and an optional detached signature, while
the client keeps reading v1 catalogs unchanged.

### 4. The host restricts where a package may come from

Because package URLs are now publisher-influenced, host-core enforces a download
host allowlist for marketplace packages — the GitHub release and raw asset hosts
and the CNB host — restricts redirects to HTTPS, re-checks the final effective
URL, and lets a custom or enterprise catalog download only from the host that
served its own catalog unless the user configured additional hosts.

### 5. Trust and review verdicts are center-issued, never publisher-asserted

`trust`, `review.decision`, `review.risk`, and `policyVersion` are written by the
center's policy evaluator, so publisher-submitted metadata cannot set them, the
client renders `community` for anything it cannot attribute to the center, and it
never renders an unverifiable claim as `verified`.

### 6. A yanked version is not installable

`yanked: true` removes a version from install and update selection, keeps it
visible in version history with its reason, and marks an installed copy as needing
attention.

## Consequences

- Third-party publishers ship on their own schedule without write access to any
  PI-Desktop-owned repository, and every installed marketplace plugin traces to a
  repository and commit the desktop can show before install.
- The default catalog URL is unchanged, so no client release, user action, or code
  change is needed beyond tolerating two catalog schemas side by side.
- Losing object storage costs WORM semantics: the Git record is tamper-evident
  rather than tamper-proof, and committed binaries make every clone pay for every
  version ever published. Publisher signing keys stay out of scope (ADR 0008).

## Alternatives

- Keep source in the marketplace repository: cannot support a publisher who is not
  a maintainer.
- Index only and download from publisher repositories: a publisher can delete or
  replace a release asset, and the client would need an open-ended host allowlist.
