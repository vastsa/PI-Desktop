# ADR 0244: Bound dependency installation for imported extensions

- Status: Accepted
- Date: 2026-09-14
- Decision: Imported pi extension dependencies use a registry-only, non-lifecycle npm boundary
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md` §3.2

## Context

The explicit `Plugins → Import pi extension` flow copies a local pi package and
may install its declared dependencies before the first sidecar load. A normal
`npm install` inherits user configuration and can resolve local paths, git
repositories, private registries, proxies, or HTTP tarballs.

## Decision

1. The importer validates registry-only specs in `dependencies`,
   `optionalDependencies`, `devDependencies`, and `peerDependencies`, plus
   recursive `overrides`.
2. npm lockfiles are accepted only when package locations, nested dependency
   specs, and every `resolved` URL are registry-safe.
3. Real npm runs with a minimal environment: user/global config files are
   isolated, the registry is fixed to `https://registry.npmjs.org/`, git
   resolution is disabled, lifecycle scripts/audit/fund/update notifications are
   disabled, and npm uses a per-import cache removed after completion.
4. Real npm traffic goes through a loopback proxy that permits only
   `registry.npmjs.org` on ports 80/443.
5. Dependency resolution and installation are separate bounded commands: `npm
   install --package-lock-only` validates the complete resolved lockfile, then
   `npm ci` installs it.
6. Imported copies omit credential files and repository metadata, create the
   destination directory atomically, and derive the plugin id from the final
   unique directory name.
7. A validated user-selected npm path is saved atomically in Main-owned
   `<dataDir>/npm-path.json` and revalidated on future imports.

## Consequences

- Private registries, private dependency URLs, git dependencies, local paths,
  npm aliases, and lifecycle-build dependencies are intentionally unsupported by
  this import path.
- The explicit import flow still requires a user-trusted local extension and a
  usable Node.js/npm installation, either on `PATH` or explicitly selected from
  a trusted installation.
- The main process owns the proxy and child-process lifecycle; dependency
  installation remains outside the renderer and sidecar.
- The dependency install and full picker/provider journey remain separate E2E
  validation surfaces; deterministic boundary and cleanup tests cover the
  security contract.
