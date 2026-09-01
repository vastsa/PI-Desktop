# 06. Desktop Release Runbook

> Scope: D126/D285 tag artifacts for macOS arm64 and Intel x64, Windows x64,
> and Linux x64;
> macOS signing/notarization remains the detailed qualification lane below.
> Cross-references: [milestones](01-mvp-milestones.md) · [process model](../03-runtime/07-process-model.md) · [security](../05-security/01-security.md)

## 1. Build lanes

| Lane | Command | Signing | Use |
|---|---|---|---|
| Dev | `pnpm dev` | none | daily development |
| Local package | `pnpm --filter @pi-desktop/desktop pack` | unsigned (`identity: null`) | packaging smoke (`--dir` output) |
| Local DMG | `pnpm --filter @pi-desktop/desktop dist` | unsigned | local install test |
| Release | `scripts/release-macos.sh` | Developer ID + optional notarization | distributable artifact |

The static electron-builder config stays unsigned-friendly (`identity: null`)
so contributors without certificates can always package. The release script
injects the real identity via `-c.mac.identity` at build time.

On macOS, `pnpm dev` creates and reuses a fingerprinted branded Electron host
bundle under `.cache/electron-dev/`. Its bundle name, executable, identifier,
and ICNS resource are development-only PI-Desktop values, so AppKit shows
PI-Desktop in the application menu and uses the canonical icon in the native
About panel. The runtime also applies `build/icon_1024.png` to the Dock. Stock
files under `node_modules` are never modified. Windows/Linux development keeps
the normal electron-vite executable. Windows Main nevertheless registers the
same `com.pi-desktop.app` AppUserModelID used by the NSIS package before
Electron readiness, preventing the stock host identity from owning native
notifications or taskbar groups. The Windows package additionally pins the
`PI-Desktop` executable and Start menu shortcut names. The launcher sets
`PI_DESKTOP_DEV=1` so runtime packaging checks keep update delivery disabled
and preserve developer workspace defaults despite the branded executable name.
The first `pnpm dev` on Electron 43+ downloads the Electron binary on demand
(the package no longer installs it during `pnpm install`).
Packaged lanes use
`build/icon.icns` through electron-builder, and the renderer imports the same
PNG through `BrandLogo`. The PNG is canonical;
`scripts/make-icon.py` derives the 512px Windows/Linux package PNG, the
transparent monochrome `build/tray-icon-mac.png` template, and the iconset/ICNS
when macOS `iconutil` is available, without overwriting the canonical source.

## 2. Prerequisites (release lane)

1. Apple Developer account with a **Developer ID Application** certificate in
   the login keychain.
2. Environment variables:
   - `MAC_SIGNING_IDENTITY` — e.g. `Developer ID Application: <Name> (<TEAMID>)`
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — required only
     for notarization; the script builds signed-but-unnotarized without them.
3. Rust toolchain and pnpm workspace installed. The Rust toolchain must run on
   the native macOS runner: arm64 for Apple Silicon or x86_64 for Intel.

## 3. What the build ships

- Electron app with hardened runtime + entitlements
  (`build/entitlements.mac.plist`: JIT + unsigned-executable-memory +
  library-validation disable — the standard Electron set).
- `Resources/bin/pi-desktop-host-core` — Rust host binary (release build).
- `Resources/agent-runtime/` — bundled sidecar, executed with
  `ELECTRON_RUN_AS_NODE=1` (no separate Node shipped).
- `Resources/licenses/` — notices that must remain distributable when the
  corresponding dependency's build-only source tree is pruned.
- `Resources/app.asar` — Electron Main, preload, renderer output, and only the
  runtime-resolved production modules. Renderer libraries are already present
  in Vite output and are not copied again as raw package trees.
- Chromium locale packs for English and Simplified Chinese only. Product
  `en`/`zh-CN` catalogs remain bundled independently of Chromium locales.
- App icon `build/icon.icns` (derived from canonical `build/icon_1024.png` by
  `scripts/make-icon.py`).
- macOS menu bar template `build/tray-icon-mac.png`, derived from the dark PI
  mark with a transparent background; Windows/Linux use the product PNG tray
  resource.

## 4. Release steps

### 4.1 Mandatory release version-surface gate (D164 + D260)

**Every product release that bumps a stable app version and cuts a tag MUST
first update every version-bearing surface: the dual-locale in-app product
changelog and the version numbers stated in project documentation.** Tagging a
stable version while any surface still describes an older version is a
**release process failure**: packaged builds cannot show "what's new" without a
network fetch, the READMEs advertise a stale release line, and GitHub
auto-generated release bodies are **not** a substitute (extends D120 /
ADR 0022).

Surfaces in scope:

| Surface | Requirement |
|---|---|
| `packages/shared/src/changelog.ts` | Newest-first EN + zh-CN entries for the version, matching highlight counts |
| `packages/shared/src/changelog.test.ts` | Version added at the top of the newest-first list |
| `package.json`, `apps/*/package.json`, `packages/*/package.json`, `docs/package.json` | Same version (`docs` is a third workspace root, not under `apps`/`packages`) |
| `Cargo.toml` `[workspace.package]`, `Cargo.lock` `host-core` | Same version |
| `packages/shared/src/protocol.ts` `APP_VERSION` | Same version |
| `README.md`, `README.zh-CN.md` | Status section states the current `<major>.<minor>.x` release line; toolchain, command, and roadmap claims still true |

Blocking steps:

1. Edit `packages/shared/src/changelog.ts` **before**
   `node scripts/release.mjs <version>` / `git tag`:
   - Add a **newest-first** entry under both `en` and `zh-CN`.
   - Same `version` string (semver **without** a leading `v`, matching
     `apps/desktop` / `APP_VERSION`).
   - Optional ISO `date` (`YYYY-MM-DD`).
   - Matching highlight counts; English is the source of truth (ADR 0009).
   - Each bullet is one short user-facing idea (not raw PR titles).
2. Do **not** catalog pre-release-only versions (`x.y.z-rc.*`) unless product
   explicitly ships in-app notes for that channel.
3. Sync the newest-first version list in
   `packages/shared/src/changelog.test.ts` (add the new version at the top),
   then run `pnpm --filter @pi-desktop/shared test` and confirm catalog
   alignment (version sets + highlight counts) still passes.
4. Update `README.md` and `README.zh-CN.md` when the release line changes
   (`0.10.x` → `0.11.x`) and whenever the release ships user-visible behavior
   the Highlights, Download, Getting started, Status, or Development sections
   now describe incorrectly. Both locales stay structurally in sync; English is
   the source of truth and the zh-CN file links the `docs/zh-CN/` mirrors.
5. Run the preflight and fix every reported surface:
   `pnpm check:release-docs [version]` (`node scripts/check-release-docs.mjs`).
   `scripts/release.mjs` runs
   the same check after bumping and refuses to commit or tag while it fails;
   `--skip-docs-check` exists only for a deliberate non-release bump.
6. Commit the documentation updates so the tagged commit contains notes and
   accurate version claims for that version (alone or adjacent to the bump).
7. GitHub Release bodies may still use `generate_release_notes: true` for the
   web page; they remain web-only and are **not** the in-app notes source.

Pre-tag checklist:

- [ ] `packages/shared/src/changelog.ts` has EN + zh-CN entries for the version
      about to be tagged
- [ ] Highlight counts match across locales
- [ ] Shared changelog tests pass
- [ ] `README.md` and `README.zh-CN.md` state the current release line and
      contain no claims the release invalidates
- [ ] `node scripts/check-release-docs.mjs` passes on the release commit
- [ ] `release.mjs` / tag runs only after the documentation commit is on the
      release branch

### 4.2 Build / package

```bash
export MAC_SIGNING_IDENTITY="Developer ID Application: ... (TEAMID)"
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
scripts/release-macos.sh
```

Artifacts land in `apps/desktop/release/` (DMG + ZIP + blockmaps).

`scripts/release-macos.sh` defaults to the host architecture and accepts
`MAC_ARCH=arm64` or `MAC_ARCH=x64` only when that architecture matches the
host. This keeps the native Rust host sidecar and Electron package aligned.

### 4.3 GitHub tag workflow

The GitHub Release workflow starts all native platform runners without a
separate validation-job barrier. Each runner validates that the pushed tag
matches `apps/desktop/package.json` immediately after checkout, before package
inputs are prepared.

On every platform, the release preparation step starts the locked Rust host
build in parallel with pnpm installation and native dependency rebuilding. It
then builds only the workspace dependencies selected by
`@pi-desktop/desktop^...`, failing if that dependency selection is unexpectedly
empty. The platform `dist:*` command remains responsible for bundling the agent
runtime, verifying the host build, building the Desktop application once, and
invoking electron-builder. This avoids a redundant Desktop build without
changing the package scripts or release artifacts.

The macOS matrix uses `macos-15` for arm64 and `macos-15-intel` for Intel x64.
Each job verifies `uname -m`, passes the matching `--arm64` or `--x64` flag to
electron-builder, and builds `pi-desktop-host-core` on that same native
runner. The per-architecture `latest-mac.yml` files are renamed before upload;
the publish job merges them into one feed after downloading both artifacts.

DMG, ZIP, NSIS, AppImage, deb, blockmap, and updater feed outputs are already
compressed or compression-insensitive. The workflow therefore uploads their
temporary Actions artifacts with compression level zero before the publish job
assembles the GitHub Release.

## 5. Verification gates

Run after every release build:

```bash
for APP in apps/desktop/release/mac-*/PI-Desktop.app; do
  codesign -dv --verbose=2 "$APP"          # identity + hardened runtime flags
  codesign --verify --deep --strict "$APP" # signature integrity
  spctl -a -vv "$APP"                      # Gatekeeper assessment (notarized builds)
  xcrun stapler validate "$APP"             # notarization staple (if notarized)
done
```

### 5.1 Package footprint gate

Inspect every native-runner package before publication and record all
compressed artifact formats, unpacked application, ASAR, Electron
framework/runtime, locale, and unpacked-native sizes. Compare them with the
previous stable release; an unexplained increase above 15% blocks publication
until reviewed.

The package inventory must confirm:

- exactly one `Resources/agent-runtime/sidecar.js` and one target-native Rust
  host binary
- no raw renderer packages such as Mermaid, Shiki, React, KaTeX, or Lucide
  under packaged `node_modules`
- no dependency `*.map`, test, example, declaration, or second agent-runtime
  tree in ASAR
- required third-party license and notice files remain in ASAR or
  `Resources/licenses` when their non-runtime package trees are pruned
- only the configured English and Simplified Chinese Chromium locale packs

The first audited optimized package establishes the platform baseline. Keep
per-platform measurements rather than applying one budget to different
Electron target layouts.

The first macOS arm64 baseline was captured on 2026-07-30 from an unsigned
`electron-builder --dir` package. Sizes below sum regular-file bytes so they
remain comparable across filesystems; the compressed artifact is not
applicable to this directory-only validation build.

| Inventory | Bytes | MiB |
|---|---:|---:|
| Unpacked application | 251,724,810 | 240.1 |
| `Contents/Frameworks` | 218,567,792 | 208.4 |
| `Contents/Resources` | 33,102,807 | 31.6 |
| `Resources/app.asar` | 20,944,962 | 20.0 |
| `Resources/app.asar.unpacked` native payload | 137,336 | 0.1 |
| English and Simplified Chinese Chromium locale packs | 1,033,673 | 1.0 |
| Agent sidecar | 3,258,983 | 3.1 |
| Rust host | 7,160,000 | 6.8 |

The pre-optimization unpacked regular-file total was 559,355,716 bytes
(533.4 MiB). The audited package is 307,630,906 bytes smaller, a 55.0%
reduction. Its curated renderer output is 14.1 MiB, down from 20.5 MiB.

#### Renderer output budget

The renderer bundle carries three standing controls. Regressing any of them
shows up as renderer growth in the table above and must be explained before
publication:

- **Minification is explicit.** `electron-vite` hard-defaults the renderer
  preset to `minify: false`, unlike plain Vite, so
  `apps/desktop/electron.vite.config.ts` sets `minify: "esbuild"`. Removing it
  silently doubles emitted JS.
- **Legacy font formats are stripped.** The `pi-drop-legacy-font-fallbacks`
  plugin removes `woff` and `truetype` `src` entries before Vite registers
  them as assets. The bundled Chromium supports `woff2` universally, so those
  faces would be emitted and never served.
- **Brand marks are renderer-sized.** `src/assets/brand/logo-{light,dark}.png`
  are the renderer assets. `build/icon_1024.png` and `build/logo_dark.png` are
  electron-builder installer icons and must not be imported by the renderer.

Renderer output measured on 2026-08-26 after applying these three controls,
against the same tree at `v0.10.8`:

| Renderer group | Before | After |
|---|---:|---:|
| JavaScript (120 chunks) | 12.53 MiB | 7.72 MiB |
| `woff2` | 15.71 MiB | 15.71 MiB |
| `woff` + `ttf` legacy fallbacks (40 files) | 0.78 MiB | 0 |
| PNG brand assets | 1.23 MiB | 0.27 MiB |
| CSS | 0.42 MiB | 0.35 MiB |
| **Total `out/renderer`** | **31 MiB** | **24 MiB** |

The two bundled CJK faces (`lxgw-wenkai.woff2` 7.6 MiB, `noto-sans-sc.woff2`
7.4 MiB) dominate the remainder. They stay unsubset on purpose: ADR 0083 §2
appends `Noto Sans SC` to every font stack so Chinese text stays readable
offline, and subsetting would drop glyphs from user-supplied content. Reducing
them requires an ADR revision, not a build-config change.

Manual smoke on a clean profile (`PI_DESKTOP_DATA_DIR=$(mktemp -d)`):

1. `pnpm dev` launches with `PI-Desktop` in the macOS application menu and the
   canonical icon in both the Dock and native About panel; no Electron brand is
   visible.
2. App launches from DMG install, window appears, and the application-menu,
   About-panel, and Dock branding match the development lane.
3. Empty home and expanded/collapsed sidebar show the canonical PI-Desktop
   logo; composer prompt rows have no leading brand icon; New task and
   project/Temporary create controls use the message-plus session icon.
4. Onboarding checklist appears; configure provider; one streamed chat turn.
5. One permissioned tool call (Write) allow + deny paths.
6. Quit/relaunch → session history restored, window bounds restored.
7. `~/.pi-desktop/logs/` contains categorized NDJSON under `app/`, `host/`,
   and `agent/`; timing records are in `host/timing.log` and
   `agent/timing.log`.
8. With network access disabled, the shell still starts; English/Chinese
   switching, syntax highlighting, shell highlighting, KaTeX, Mermaid
   fallback/rendering, host health, and sidecar health continue to use packaged
   local assets.

## 6. Native-runner release packages

The repository exposes native-runner commands for every release target. Each
packaging command first runs `build:host-release`, then bundles the agent
runtime and Electron app. D126/D285 tag workflows publish these outputs and
their electron-updater manifests. Run a target command on that target OS:

```text
macOS Apple Silicon: pnpm --filter @pi-desktop/desktop run dist:mac -- --arm64
macOS Intel:         pnpm --filter @pi-desktop/desktop run dist:mac -- --x64
Windows: pnpm --filter @pi-desktop/desktop dist:win
Linux:   pnpm --filter @pi-desktop/desktop dist:linux
```

The macOS packages include `bin/pi-desktop-host-core` built for their runner
architecture; Windows includes `bin/pi-desktop-host-core.exe`; Linux includes
`bin/pi-desktop-host-core`. Signing, rollback, and installer upgrade
qualification remain release hardening work; publication is active under
D126/D285.

Native-runner output matrix:

- macOS arm64: DMG and ZIP
- macOS Intel x64: DMG and ZIP
- Windows x64: NSIS installer
- Linux x64: AppImage and deb

Shell smoke on each native runner:

1. Confirm no File/Edit/View/Window/Help menu appears inside the window.
2. Verify F10 and Shift+F10 remain available to focused content.
3. Execute application and editing shortcuts from a focused editor.
4. Minimize, maximize, restore, and close from the custom controls.
5. Relaunch with `PI_DESKTOP_START_MAXIMIZED=1`; confirm the initial
   maximize/restore glyph matches the queried native state.
6. Verify unknown menu/window IPC actions fail with the window open and closed.

## 7. Known limitations

- macOS and Linux deb remain notify-and-link update modes.
- Signed in-app macOS delivery, rollback, staged rollout, and prerelease
  channel policy remain open release work.
