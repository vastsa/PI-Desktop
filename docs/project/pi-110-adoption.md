# Pi 1.1.0 adoption

## Scope

All five direct Pi dependencies used by Agent Runtime and Electron Main are
pinned exactly to `1.1.0`. The three Desktop patches were rebased against the
published 1.1.0 packages and the lockfile records their patch hashes.

| Workspace entry | Direct dependencies |
| --- | --- |
| `packages/agent-runtime` | `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` |
| `apps/desktop` | `@earendil-works/pi-ai`, `@earendil-works/pi-mcp` |

The 1.1.0 upgrade adopts pi-ai's monotonic `AssistantMessage.durationMs` for
completed-response throughput. If the final message has no valid duration,
the existing sidecar stopwatch remains in use, including for interrupted
responses. This uses the existing `responseDurationMs` transcript field; no IPC
or storage schema changes are needed.

The upstream release also brings its current provider support, retry fixes and
context-estimation changes. The rebased PI-Desktop patches preserve hosted
search replay and estimation, local request error details, bounded Anthropic
OAuth retries, DeepSeek's published system-message capability, and the upstream
3.5-characters-per-token estimator. The new OpenAI Decisions classifier is not
enabled by default because invoking it adds a separate outbound classification
request; the existing explicit classifier configuration remains authoritative.

Official release notes: [Pi 1.1.0 changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/CHANGELOG.md).

## Fresh-release policy

The Pi 1.1.0 release group is inside the configured minimum-release-age window.
`pnpm-workspace.yaml` therefore contains exact-version exclusions for the eight
published release-group packages. The dependency check rejects missing,
additional, wildcard, or non-1.1.0 exclusions. Remove the entries after the
release group clears the age window and regenerate the lockfile; do not widen
them.

## Patch identity

| Package | Patch SHA-256 |
| --- | --- |
| `@earendil-works/pi-agent-core@1.1.0` | `a2c96619d0f9a1d643a6c6a555ba6a7fb533147336c181f7d3b7f847be33a6eb` |
| `@earendil-works/pi-ai@1.1.0` | `9f3713107628b7e52bc90d1bab011e3d819fec598ce1eac47d389aad0bd96dcd` |
| `@earendil-works/pi-coding-agent@1.1.0` | `a2878f6aa1d66afa239d6be4252403a73df48b702b3e582aaae04bd90bf3d354` |

The `check:pi-dependencies` and `check:pi-patches` scripts verify exact direct
pins, installed package versions, patch mappings and lockfile identities, and
representative patched source and declaration contracts.

## Validation

- Task candidate base: `origin/main` at `727e0b3a9932b8a5e8c9d75498e9372e642642f8`.
- `pnpm check:pi-dependencies`, `pnpm check:pi-patches`, and
  `node --test scripts/pi-patch-hash.test.mjs` passed.
- `pnpm --filter @pi-desktop/agent-runtime test` passed (94 files, 1,308
  tests); desktop typecheck, `pnpm lint`, and `pnpm build:js` passed.
- `pnpm test:e2e` passed 23/23 protocol smoke checks. The two live-model
  checks were skipped because no API key was set; the test endpoint was pointed
  at localhost to prevent outbound model requests.
- PR integration candidate validation is still pending.

## Rollback

Rollback the dependency manifests, lockfile, release-age entries, patch files,
and version references together. Do not roll back an individual patched Pi
package while retaining the others at 1.1.0.
