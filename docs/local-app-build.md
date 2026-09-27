# Local macOS and Windows app builds

These entry points package **this modified checkout**, including the fixed
platform provider, bundled media Skill and inline video player. They do not
publish a release, change source versions, modify global Cargo configuration,
or reuse signing credentials from your environment.

## Build machines and requirements

| Target | Build on | Output |
| --- | --- | --- |
| macOS Apple Silicon | Native arm64 macOS, arm64 Node/Rust | `.app`, `.dmg`, `.zip` |
| macOS Intel | Native Intel macOS, x64 Node/Rust | `.app`, `.dmg`, `.zip` |
| Windows x64 | Windows x64, x64 Node and MSVC Rust | NSIS setup `.exe`, portable `.exe`, `.zip`, unpacked app |

Do not cross-build Windows from a Mac or request an Intel build from an Apple
Silicon toolchain. Electron native addons and the Rust host must match the
target platform. There is no universal macOS bundle in this lane. Use separate
native machines/runners for the three rows above.

Install once:

- Node.js **22.19+**, preferably Node 24 LTS.
- pnpm **10+**; use the version in the root `packageManager` field (currently
  `10.34.5`). For example, `npm install --global pnpm@10.34.5`.
- Rust stable through [rustup](https://rustup.rs/). The scripts also look in
  `$CARGO_HOME/bin` or `~/.cargo/bin` when Cargo is absent from PATH.
- macOS: Xcode Command Line Tools (`xcode-select --install`).
- Windows: Visual Studio 2022 Build Tools, **Desktop development with C++**, the
  MSVC x64/x86 toolset and Windows 10/11 SDK. Use the normal
  `x86_64-pc-windows-msvc` Rust toolchain, not GNU. If native addon rebuilding
  requires it, install CMake as well.
- Working access to npm, Cargo, Electron and electron-builder downloads. The
  first build needs network access and several GB of free space.

**Python 3.9+ remains a runtime prerequisite for image/video tools on each end
user's machine. It is not bundled into these installers.** On Windows enable
Add Python to PATH, or install the `py -3` launcher. No pip packages are required.

## macOS

From the repository root:

```bash
bash scripts/build-macos.sh --check
bash scripts/build-macos.sh
```

The first command validates tools without compiling or installing anything. The
second installs locked dependencies only if the checkout lacks them, builds the
release Rust host, desktop dependency packages, agent runtime and Electron
bundles, then creates DMG and ZIP packages. An unpacked `.app` is also retained.

```bash
# Faster packaging verification: .app only, no DMG/ZIP compression
bash scripts/build-macos.sh --dir

# If crates.io is unreachable, use rsproxy.cn for this Cargo process only
bash scripts/build-macos.sh --cargo-mirror

# Force dependency installation using the existing lockfile
bash scripts/build-macos.sh --install
```

Output:

```text
apps/desktop/release/local/mac-arm64/
apps/desktop/release/local/mac-x64/
```

The directory contains `PI-Desktop-<version>-<arch>.dmg`,
`PI-Desktop-<version>-<arch>-mac.zip` and an unpacked `PI-Desktop.app` beneath
electron-builder's architecture directory. Apple Silicon uses `mac-arm64/`;
Intel normally uses `mac/` for the inner unpacked directory.

## Windows

Copy the **complete modified source checkout** to Windows first. Do not clone
the upstream repository and expect the local uncommitted platform changes to be
there. Retain hidden source configuration such as `.cargo/`, plus `patches/`;
do not copy macOS `node_modules/`, `target/`, `out/` or release artifacts. Install
dependencies natively on Windows. Run these commands in PowerShell at the root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 -Check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
```

`-ExecutionPolicy Bypass` applies only to this PowerShell process; it does not
change the machine policy. Inspect the script before running it. PowerShell 7
users can substitute `pwsh` for `powershell`.

```powershell
# Unpacked application only
.\scripts\build-windows.ps1 -Dir

# Optional Cargo mirror, without writing global Cargo settings
.\scripts\build-windows.ps1 -CargoMirror

# Reinstall locked native dependencies
.\scripts\build-windows.ps1 -Install
```

Output: `apps\desktop\release\local\win-x64\`

- `PI-Desktop-Setup-<version>.exe`: NSIS installer.
- `PI-Desktop-Portable-<version>.exe`: portable executable.
- `PI-Desktop-Portable-<version>.zip`: unpack-and-run ZIP.
- `win-unpacked\PI-Desktop.exe`: unpacked application.

Each Windows package retains its own installed/ZIP/portable distribution marker.
Build paths containing spaces are supported. If the Windows temporary directory
contains quotes, `%` or `!`, use a simpler `TEMP`/`TMP` path for this build;
the wrapper refuses to expand shell expressions in a generated config path.

## Shared CLI and behavior

The two native wrappers call `scripts/build-platform-app.mjs`, which can also be
used directly or through these root package scripts:

```bash
pnpm build:mac
pnpm build:windows
node scripts/build-platform-app.mjs win --dry-run
pnpm test:app-build
```

`--dry-run` prints a plan even on a different host; it does **not** validate
prerequisites or create an app. `--check` verifies the real native host/tools.
`--help` lists flags. Unsupported flags/hosts fail before compilation, and any
failed stage stops the build before later packaging steps. Run only one build
at a time per checkout because native dependencies and generated bundles are
shared. Build errors remain visible and return a nonzero exit status.

The Rust build uses an explicit native target and a locked Cargo dependency set.
Packaging reads that target's release binary, not an old binary from another
architecture or an environment-dependent output directory. Temporary builder
configuration is cleaned up; existing source packaging configuration is not
rewritten. Existing dependency trees are reused by default.

## Local package versus public release

These are **local testing builds**, not signed public releases:

- macOS uses ad-hoc signing, not a Developer ID certificate or notarization.
  Gatekeeper may require explicit approval for a downloaded build.
- Windows executables are unsigned and may show SmartScreen warnings.
- `--publish never` prevents uploading; the generated package config also has
  `publish: null`, so it does not embed the upstream automatic-update feed.
  The existing update UI may report that local update configuration is missing;
  no fork update service has been implemented here.
- PI-Desktop's existing product name, app ID, profile identity, artwork and
  upstream attribution remain unchanged. **Do not overwrite another PI-Desktop
  installation or assume its data profile is isolated.** To test separately,
  launch the unpacked executable with `PI_DESKTOP_DATA_DIR` pointing at a new
  test directory.
- Before public distribution, configure your own app identity/data separation,
  signing/notarization and update service, and satisfy the retained LGPL license
  and third-party notices. Do not use the upstream owner's release-signing
  helper or certificates for this fork.

The bundled platform token is **not** configured by packaging. Users register,
recharge and create an API token at [AI Aggregation Platform](https://ai.yykkj.com),
then save it in Settings > Models. Never add API keys to source or build config.
