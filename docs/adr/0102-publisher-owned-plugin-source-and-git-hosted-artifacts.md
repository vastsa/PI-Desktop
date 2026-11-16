# ADR 0102: Publisher-owned plugin source with a Git-hosted artifact store

> Amended 2026-08-19: artifacts are committed to the existing distribution
> repository rather than published as releases of the center repository. The
> ownership model and every other decision below are unchanged.

- Status: Accepted for implementation
- Date: 2026-08-18
- Deciders: PI-Desktop plugin and distribution maintainers
- Supersedes: ADR 0006 (marketplace postponed)
- Amends: ADR 0007 (plugin package format), ADR 0005 (user-installable plugins)

## Context

The shipped marketplace stores everything in one repository.
`vastsa/pi-desktop-plugins` holds plugin source under `plugins/<id>/`, built
packages under `packages/*.piplug`, and the `catalog.json` the client reads.

- Plugin source has no owner outside the marketplace repository.
- The marketplace repository grows binary packages forever and its Git history
  becomes the artifact store by accident.
- Nothing binds a published package to the source that produced it.
- `verified` is a hand-edited catalog field.

## Decision

### 1. The publisher's repository is the source of truth

A publisher submits a repository coordinate — canonical HTTPS repository URL,
path, and a ref that resolves to a 40-hex commit. PI-Desktop never copies plugin
source into a project-owned repository.

### 2. Management and distribution are separate repositories

`vastsa/pi-plugin-center` is the management plane: submissions, ownership
verification, isolated builds, review, the policy gate, and the registry that
records what has been published.

`vastsa/pi-desktop-plugins` stays the distribution repository. It keeps serving
`catalog.json` from its root and packages from `packages/`, and the CNB copy
keeps mirroring it.

- The publisher builds and attaches `<id>-<version>.piplug` to a release in
  their own repository, or the center's isolated runner builds it from the
  pinned commit.
- The center verifies the bytes, then commits the package to
  `pi-desktop-plugins/packages/` together with a regenerated `catalog.json`, in
  one commit.
- Package URLs stay relative, so they resolve against whichever host served the
  catalog.

### 3. Catalog schema v2 is the client contract

`catalog.json` gains `schemaVersion: 2` and carries, per version: the source
repository, ref, commit and path; the builder identity; the review decision,
risk tier and policy version; `yanked` state; and an optional detached
signature. The client keeps reading v1 catalogs unchanged so the existing
marketplace repository and any custom source keep working during migration.

### 4. The host restricts where a package may come from

Because package URLs are now publisher-influenced, host-core enforces a download
host allowlist for marketplace packages: the GitHub release and raw asset hosts,
and the CNB host. Redirects are restricted to HTTPS and the final effective URL
is re-checked against the allowlist.

### 5. Trust and review verdicts are center-issued, never publisher-asserted

`trust`, `review.decision`, `review.risk`, and `policyVersion` are written by
the center's policy evaluator. Publisher-submitted metadata cannot set them.

### 6. A yanked version is not installable

`yanked: true` removes a version from install and update selection, keeps it
visible in version history with its reason, and marks an installed copy as
needing attention.

## Consequences

- Third-party publishers can ship plugins without write access to any
  PI-Desktop-owned repository, and can version on their own schedule.
- The default catalog URL is unchanged, so no client release and no user action
  is needed to reach plugins published through the center.
- The client needs no code change for this decision: relative package URLs
  already resolve against the catalog that carried them, and the download host
  allowlist already covers both distribution hosts.
- Every installed marketplace plugin can be traced to a repository and commit,
  and the desktop can show that provenance before install.
- Losing object storage costs WORM semantics and versioned-bucket retention.

## Rejected alternatives

- **Keep source in the marketplace repository.** Simple, already working, and
  cannot support a publisher who is not a maintainer.
- **Index only; download from publisher repositories.** Removes the center from
  the download path entirely, but a publisher can delete or replace a release
  asset out from under a published version, and the client would need an
  open-ended host allowlist.
- **Publish artifacts as releases of the distribution repository.** Keeps Git
  history free of binaries and allows pruning old versions, at the cost of a
  catalog that must declare an artifact base, and a CNB mirror that has to
  replicate release assets separately instead of riding along with the Git
  mirror that already exists.
- **Center builds every plugin from source with no publisher artifact.**
  Strongest reproducibility, and makes the center responsible for every plugin's
  toolchain and dependency supply chain from day one.
