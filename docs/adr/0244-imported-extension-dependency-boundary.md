# ADR 0244: Bound dependency installation for imported extensions

- Status: Accepted
- Date: 2026-09-14
- Decision: Imported pi extension dependencies use a registry-only, non-lifecycle npm boundary
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md` §3.2

## Context

The explicit `Plugins → Import pi extension` flow copies a local pi package and
may install its declared dependencies before the first sidecar load. A normal
`npm install` inherits user configuration and can resolve local paths, git
repositories, private registries, proxies, or HTTP tarballs. `--ignore-scripts`
alone does not provide a sufficient boundary, and a packaged PI-Desktop build
does not ship a standalone Node/npm executable.

## Decision

1. The importer validates registry-only specs in `dependencies`,
   `optionalDependencies`, `devDependencies`, and `peerDependencies`, plus
   recursive `overrides`. Invalid values fail before npm starts.
2. npm lockfiles are accepted only when package locations, nested dependency
   specs, and every `resolved` URL are registry-safe. Unsupported lockfile
   formats are removed; unsafe lockfiles are not reused.
3. Real npm runs with a minimal environment: user/global config files are
   isolated, the registry is fixed to `https://registry.npmjs.org/`, git
   resolution is disabled, lifecycle scripts/audit/fund/update notifications
   are disabled, and npm uses a per-import cache removed after completion.
4. Real npm traffic goes through a loopback proxy that permits only
   `registry.npmjs.org` on ports 80/443. This blocks non-registry transitive
   HTTP(S) tarballs and redirects. Git sources are rejected by validation or
   the disabled git resolver.
5. Dependency resolution and installation are separate bounded commands:
   `npm install --package-lock-only` validates the complete resolved lockfile,
   then `npm ci` installs it. A failure removes partial `node_modules`, cache,
   and generated lockfiles while preserving a safe source lockfile when possible.
6. Imported copies omit credential files and repository metadata, create the
   destination directory atomically, and derive the plugin id from the final
   unique directory name. Missing npm or Node.js has a structured unavailable
   error and a Main-owned native executable picker recovery flow (spec §3.2).
   Cancellation or a dependency failure remains non-blocking for registration.
7. A validated user-selected npm path is saved atomically in Main-owned
   `<dataDir>/npm-path.json` and revalidated on future imports. Stale choices
   prompt again; save failure warns without preventing the current install.
   Validation uses bounded npm/Node version checks and the install child alone
   receives the selected directory in `PATH`. No shell startup probing, global
   environment mutation, or credential inheritance is introduced. Recovery
   retries the existing generated directory and registers it exactly once.

## Consequences

- Private registries, private dependency URLs, git dependencies, local paths,
  npm aliases, and lifecycle-build dependencies are intentionally unsupported
  by this import path.
- The explicit import flow still requires a user-trusted local extension and a
  usable Node.js/npm installation, either on `PATH` or explicitly selected from
  a trusted installation. Ordinary registry/network errors do not prompt for a
  different executable.
- The main process owns the proxy and child-process lifecycle; dependency
  installation remains outside the renderer and sidecar.
- The dependency install and full picker/provider journey remain separate E2E
  validation surfaces; deterministic boundary and cleanup tests cover the
  security contract.
