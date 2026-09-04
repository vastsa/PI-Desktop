# scripts

Repository automation. Every script here is invoked from a `package.json`
script, from a GitHub workflow, or by hand during a release; the alias column
gives the invocation the rest of the documentation quotes.

## Release gates

These are the checks that block a release. `release.mjs` runs the
release-documentation gate itself and refuses to tag while any version surface
disagrees, so a green `check:release-docs` is a precondition, not a substitute.

| Script | Alias | Purpose |
|---|---|---|
| `release.mjs` | `node scripts/release.mjs <version> [--tag]` | Bump every workspace version surface, commit, and optionally create the `vX.Y.Z` tag the Release workflow builds from |
| `check-release-docs.mjs` | `pnpm check:release-docs` | Verify the changelog, its test list, `APP_VERSION`, workspace versions, Cargo versions, and both README release lines agree |
| `check-marketplace-catalog.mjs` | `pnpm check:marketplace -- --url <url> --plugin <id>` | Marketplace catalog preflight; rejects a version record missing a checksum, package URL, size, or permissions |
| `check-style-tokens.mjs` | run by the desktop `lint` script | Fail renderer styles that hardcode values instead of design-system tokens |

## Packaging

| Script | Alias | Purpose |
|---|---|---|
| `release-macos.sh` | `scripts/release-macos.sh` | Signed, and with Apple credentials notarized, local native macOS lane. Defaults to the host architecture; `MAC_ARCH=arm64` or `MAC_ARCH=x64` must match the host. Injects `MAC_SIGNING_IDENTITY` through `-c.mac.identity` because the static electron-builder config stays `identity: null` |
| `make-icon.py` | `python3 scripts/make-icon.py` | Derive the package PNG, the macOS tray template, and the iconset/ICNS from the canonical PNG |
| `publish-screenshots.py` | `python3 scripts/publish-screenshots.py` | Publish documentation screenshots |

## Development

| Script | Alias | Purpose |
|---|---|---|
| `dev-electron.mjs` | `pnpm dev`, through `predev` | Launch Electron against the dev server. On macOS it builds and reuses the fingerprinted branded host bundle under `.cache/electron-dev/` |

## End-to-end

Do not run these from an agent session, and do not trigger the remote jobs by
hand, unless the request explicitly asks for it (see `AGENTS.md`). The scenarios
they cover are specified in
[the E2E test plan](../docs/spec/06-delivery/04-e2e-test-plan.md).

| Script | Alias | Purpose |
|---|---|---|
| `e2e-smoke.mjs` | `pnpm test:e2e` | Protocol-level E2E against host-core, plus an optional live model |
| `e2e-plan.mjs` | `pnpm test:e2e:plan` | Plan state, checkpoint artifact, and approval transitions |
| `e2e-plan-ui.mjs` | `pnpm test:e2e:plan-ui` | Plan approval through the rendered UI |
| `e2e-electron-boot.mjs` | `pnpm test:e2e:boot` | Electron boot probe |
| `e2e-supervision.mjs` | `pnpm test:e2e:supervision` | Process supervision and restart behavior |
| `e2e-subagents.mjs` | `pnpm test:e2e:subagents` | Subagent registry over RPC, then through the real loader (D202) |
| `e2e-agent-live.mjs` | `node scripts/e2e-agent-live.mjs` | Live streaming chat through agent-runtime + host-core. Needs real provider credentials, so it has no `pnpm` alias |

## Continuous integration

`.github/workflows/ci.yml` runs two jobs on pushes to `main`, on pull requests,
and on manual dispatch, skipping both when a change touches only `docs/**` or
`**/*.md`:

- **JS build / typecheck / lint / test** — `pnpm install --frozen-lockfile`,
  `pnpm build:js`, `pnpm --filter @pi-desktop/desktop typecheck`, `pnpm lint`,
  `pnpm -r --if-present test`
- **Rust host-core test** — `cargo test -p host-core --locked`

`.github/workflows/release.yml` builds on a `v*.*.*` tag. Each platform runner
validates the tag against `apps/desktop/package.json` before packaging, then
runs the native `dist:mac`, `dist:win`, or `dist:linux` command; the macOS
matrix covers arm64 and Intel x64 and the publish job assembles the GitHub
Release. See the
[release runbook](../docs/spec/06-delivery/06-release-runbook.md).
