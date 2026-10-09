# Pi 1.1.0 adoption

Status: PR candidate on `upgrade/pi-1.1.0`.

## Scope

PI-Desktop upgrades the Pi runtime release group from `1.0.1` to `1.1.0`. The
sidecar pins `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and
`@earendil-works/pi-coding-agent` together; Electron Main follows with
`@earendil-works/pi-ai` and `@earendil-works/pi-mcp`. The transitive Pi release
group (`chord`, `pi-codemode`, `pi-telemetry`, and `pi-tui`) resolves at the same
exact release through the coding-agent dependency graph.

The primary user-visible correction is the OpenCode Go model catalog. Pi AI
1.1.0 publishes `claude-haiku-5-5` as an `anthropic-messages` model at
`https://opencode.ai/zen/go`, so the GUI no longer routes that model through an
incompatible OpenAI protocol.

The three PI-Desktop patches are rebased onto the published 1.1.0 package
contents. They retain hosted-search replay and estimation, local-request error
metadata, model-aware compaction, native Pi session compatibility, and the
trusted-extension compatibility surface.

## Dependency invariants

- All direct Pi pins are exact `1.1.0` versions.
- The three patched packages use pnpm's versioned `1.1.0` patch mappings.
- Patch hashes in `pnpm-lock.yaml` match the generated patch files.
- The extension shim's `TRUSTED_EXTENSION_KERNEL_VERSION` remains independent
  of the Pi package release.

## Validation

The upgrade is accepted only when the dependency and patch gates, JavaScript
build, type checks, agent-runtime tests, desktop tests, lint, and the relevant
bundled-sidecar regressions pass against the locked 1.1.0 dependency graph.

## Rollback

Rollback the direct pins, release-age exclusions, patch mappings, patch files,
lockfile, and current-runtime documentation together. Do not mix Pi package
versions across the sidecar.
