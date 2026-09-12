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
| `check-marketplace-catalog.mjs` | `pnpm check:marketplace -- --url <url> --plugin <id>` | Marketplace catalog preflight; rejects a version record missing a checksum, package URL, size, or permissions, and a catalog `author` that is not a string |
| `check-style-tokens.mjs` | run by the desktop `lint` script | Fail renderer styles that hardcode values instead of design-system tokens |

## Packaging

| Script | Alias | Purpose |
|---|---|---|
| `release-macos.sh` | `scripts/release-macos.sh` | Signed and notarized local native macOS release lane. Requires `MAC_SIGNING_IDENTITY` and Apple notarization credentials; local package and distribution lanes remain unsigned when no signing identity is configured. |
| `staple-macos-release-dmg.sh` | `scripts/staple-macos-release-dmg.sh [release-dir]` | Attach Apple's notarization ticket (`xcrun stapler staple`) to the single DMG a native macOS job produced; run by the Release workflow when `sign_macos` is set |
| `verify-macos-release.sh` | `scripts/verify-macos-release.sh [release-dir]` | Fail unless the one `PI-Desktop.app` and DMG under the release directory are Developer ID-signed, notarized, and stapled; run by the Release workflow after stapling |
| `export-linux-asar.mjs` | `node scripts/export-linux-asar.mjs` | Copy the Linux `linux-unpacked/resources/app.asar` into the versioned release asset used for system-Electron repackaging |
| `check-linux-host-glibc.mjs` | `node scripts/check-linux-host-glibc.mjs [bin]` | Fail a Linux host-core binary whose needed glibc is above 2.35 |
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
| `e2e-agent-live.mjs` | `node scripts/e2e-agent-live.mjs` | Live streaming chat through agent-runtime + host-core. Requires `PI_DESKTOP_TEST_API_KEY`, `PI_DESKTOP_TEST_BASE_URL`, and `PI_DESKTOP_TEST_MODEL` (no defaults), so it has no `pnpm` alias |

## Continuous integration

`.github/workflows/ci.yml` runs two jobs on pushes to `main`, on pull requests,
and on manual dispatch, skipping both when a change touches only `docs/**` or
`**/*.md`:

- **JS build / typecheck / lint / test** — `pnpm install --frozen-lockfile`,
  `pnpm build:js`, `pnpm --filter @pi-desktop/desktop typecheck`, `pnpm lint`,
  `pnpm -r --if-present test`
- **Rust host-core test** — `cargo test -p host-core --locked`

`.github/workflows/docs-check.yml` covers the paths `ci.yml` ignores: it runs
`pnpm docs:check` (the docs locale pair check) when `docs/**`, the READMEs, the
shared changelog sources, or the check scripts change. `check:release-docs` is
deliberately not in CI because it fails on rc versions by design.

`.github/workflows/release.yml` builds on a `v*.*.*` tag. A `verify` job first
repeats the `ci.yml` checks (a tag push does not trigger `ci.yml`), and the
build matrix waits for it. Each platform runner then
validates the tag against `apps/desktop/package.json` before packaging, then
runs the native `dist:mac`, `dist:win`, or `dist:linux` command. The Linux
job uses Ubuntu 22.04 so host-core stays on glibc 2.35, then
`scripts/check-linux-host-glibc.mjs` refuses a binary that needs a newer
glibc. The Linux runner also exports the exact app.asar from `linux-unpacked`
as a versioned release asset; the macOS matrix covers arm64 and Intel x64 and
the publish job assembles the GitHub Release. The release workflow defaults to
unsigned macOS artifacts; manually dispatch it with `sign_macos: true` to opt
into signing and notarization. See the [release
runbook](../docs/spec/06-delivery/06-release-runbook.md).
