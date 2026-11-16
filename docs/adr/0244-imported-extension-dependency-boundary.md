# ADR 0244: Bound dependency installation for imported extensions

- Status: Accepted
- Date: 2026-09-14
- Decision: Imported pi extension dependencies use a registry-only, non-lifecycle
  npm boundary
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md` §3.2

## Context

The `Plugins → Import pi extension` flow copies a local pi package and may
install its declared dependencies before the first sidecar load. A normal
`npm install` inherits user configuration and can resolve local paths, git
repositories, private registries, proxies, or HTTP tarballs, `--ignore-scripts`
alone is not a boundary, and a packaged build ships no standalone npm.

## Decision

The importer accepts only registry-safe specs in `dependencies`,
`optionalDependencies`, `devDependencies`, `peerDependencies`, and recursive
`overrides`, failing before npm starts. A lockfile is usable only when package
locations, nested dependency specs, and every `resolved` URL are registry-safe;
unsupported lockfile formats are removed and unsafe lockfiles are never reused.

Real npm runs with an isolated minimal environment — user and global config
ignored, registry fixed to `https://registry.npmjs.org/`, git resolution
disabled, lifecycle scripts, audit, fund, and update notifications off, and a
per-import cache deleted afterwards — and its traffic passes through a loopback
proxy that permits only `registry.npmjs.org` on ports 80 and 443. Resolution and
installation stay separate bounded commands, `npm install --package-lock-only`
then `npm ci`, and a failure removes partial `node_modules`, the cache, and
generated lockfiles while keeping a safe source lockfile when possible.

Imported copies omit credential files and repository metadata, create the
destination atomically, and derive the plugin id from the final unique directory
name. A missing npm or Node.js yields a structured unavailable error and a
Main-owned native picker; the chosen executable is saved atomically in
`<dataDir>/npm-path.json`, revalidated on later imports, and passed to the
install child alone through `PATH`, while cancellation or dependency failure
stays non-blocking for registration.

## Consequences

- Private registries, private dependency URLs, git dependencies, local paths,
  npm aliases, and lifecycle-build dependencies are unsupported on this path.
- Import still requires a user-trusted local extension and a usable Node.js/npm,
  and the main process owns the proxy and child-process lifecycle.
- Registry and network errors do not prompt for a different executable.
