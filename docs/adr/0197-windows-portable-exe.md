# ADR 0197: Publish a Windows Portable Package

- Status: Accepted (amended by D603)
- Date: 2026-09-22
- Related: D120, D126, D364, D603, ADR 0022, E2E-211

## Context

Windows tag releases publish an NSIS installer, but company environments that
whitelist a single executable or block installers need a no-install package.
electron-builder's `portable` target produced a self-extracting wrapper that
could trigger an administrator prompt and gave no reliable normal executable
identity for the taskbar.

## Decision

The Windows x64 release lane publishes both NSIS and ZIP, with the no-install
artifact named `PI-Desktop-Portable-${version}.zip` and built in a separate
electron-builder invocation. Packaged metadata marks ZIP builds with
`piDistribution = "zip"` and installed builds with `"installed"`; ZIP builds
write no `latest.yml` and use notify-and-link delivery, while NSIS installs keep
in-app download and quit-and-install. The updater still recognizes
`PORTABLE_EXECUTABLE_FILE` for older portable executables, but ordinary ZIP
launches use the packaged marker. User data, logs, and secrets stay in the
existing application data directory.

## Consequences

- Users who cannot run an installer extract the ZIP and launch
  `PI-Desktop.exe` without a self-extracting wrapper.
- The extracted executable keeps the normal taskbar identity and icon.
- ZIP users replace the application themselves; NSIS in-app updates and feed
  ownership are unchanged.

## Alternatives

- Keep electron-builder's `portable` target: rejected, its wrapper causes the
  administrator prompt and taskbar-identity problems.
- Beside-the-exe data directory: rejected, it is an unrelated data-ownership
  change and `PI_DESKTOP_DATA_DIR` already relocates the profile.
