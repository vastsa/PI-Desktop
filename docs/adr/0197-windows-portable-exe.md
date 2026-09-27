# ADR 0197: Publish a Windows Portable Executable

- Status: Accepted
- Date: 2026-09-09
- Deciders: PI-Desktop core
- Related: D120, D126, D364, ADR 0022, E2E-211

## Context

Windows tag releases published only an NSIS installer
(`PI-Desktop-Setup-<version>.exe`). Company environments that whitelist a
single executable, or that block installers, cannot run that artifact without
an approved install. The request is a no-install `.exe`, not a change to data
ownership or to the NSIS in-app update lane.

electron-builder's `portable` target produces a user-level self-extracting
executable. It does not write `latest.yml`. Applying the NSIS updater to a
portable run would launch the installer and convert the no-install copy into
an installed one.

## Decision

1. The Windows x64 release lane publishes both NSIS and portable targets.
2. The portable artifact name is space-free:
   `PI-Desktop-Portable-${version}.exe`.
3. Portable requests `user` execution level so launch does not require
   administrator rights.
4. electron-builder continues to write `latest.yml` only for NSIS. Portable
   does not become an auto-update payload.
5. Packaged portable runs are detected by `PORTABLE_EXECUTABLE_FILE` and use
   notify-and-link delivery. NSIS installs keep in-app download and
   quit-and-install.
6. User data, logs, and secrets stay in the existing application data
   directory. This decision does not introduce a beside-the-exe profile.

## Consequences

- Windows users who cannot run an installer can download and launch one
  executable from the GitHub Release.
- Portable users discover updates in-app and open the releases page; they
  replace the portable file themselves.
- NSIS in-app updates, hashes, and feed ownership are unchanged.
- The portable process still unpacks application files under the Windows temp
  directory for that launch. Whitelisting applies to the downloaded portable
  executable; a policy that also blocks temp-directory execution may still
  require the NSIS install.

## Alternatives considered

- Zip of `win-unpacked` only: rejected as the requested artifact is a
  no-install `.exe`.
- In-app update of portable via the NSIS installer: rejected because it would
  install the application and require a whitelisted installer.
- Beside-the-exe data directory: rejected as an unrelated data-ownership
  change; `PI_DESKTOP_DATA_DIR` already relocates the profile when needed.
