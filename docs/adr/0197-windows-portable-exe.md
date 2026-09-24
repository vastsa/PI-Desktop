# ADR 0197: Publish a Windows Portable Package

- Status: Accepted (amended by D603)
- Date: 2026-09-22
- Deciders: PI-Desktop core
- Related: D120, D126, D364, D603, ADR 0022, E2E-211

## Context

Windows tag releases publish an NSIS installer
(`PI-Desktop-Setup-<version>.exe`). Company environments that whitelist a
single executable, or that block installers, also need a no-install package.
The previous electron-builder `portable` target produced a self-extracting
executable. In some Windows environments that wrapper could trigger an
administrator prompt and did not provide a reliable normal executable identity
for the taskbar.

The no-install lane must not change data ownership or the NSIS in-app update
lane. A normal ZIP lets the user choose the extraction directory and launches
the packaged `PI-Desktop.exe` directly.

## Decision

1. The Windows x64 release lane publishes both NSIS and ZIP targets.
2. The no-install artifact name is space-free:
   `PI-Desktop-Portable-${version}.zip`.
3. The Windows release helper builds NSIS and ZIP in separate
   electron-builder invocations. The ZIP app metadata contains
   `piDistribution = "zip"`; installed builds contain `piDistribution =
   "installed"`.
4. The ZIP target does not write `latest.yml`. Packaged ZIP runs use
   notify-and-link delivery, while NSIS installs keep in-app download and
   quit-and-install.
5. The updater continues to recognize `PORTABLE_EXECUTABLE_FILE` for older
   portable executables, but ordinary ZIP launches use the packaged metadata
   marker instead.
6. User data, logs, and secrets stay in the existing application data
   directory. This decision does not introduce a beside-the-exe profile.

## Consequences

- Windows users who cannot run an installer can download, extract, and launch
  `PI-Desktop.exe` from the ZIP without a self-extracting wrapper.
- The extracted executable keeps the normal PI-Desktop Windows identity for
  taskbar grouping and icon display.
- ZIP users discover updates in-app and open the releases page; they replace
  the extracted application themselves.
- NSIS in-app updates, hashes, and feed ownership are unchanged.
- The ZIP package is larger on disk after extraction than the old temporary
  self-extracting wrapper, but it avoids runtime extraction and its related
  execution-policy prompts.

## Alternatives considered

- Keep electron-builder's `portable` target: rejected because its
  self-extracting wrapper is the source of the administrator-prompt and
  taskbar-identity problems this amendment addresses.
- In-app update of ZIP via the NSIS installer: rejected because it would
  install the application and require a whitelisted installer.
- Beside-the-exe data directory: rejected as an unrelated data-ownership
  change; `PI_DESKTOP_DATA_DIR` already relocates the profile when needed.
