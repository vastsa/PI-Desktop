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
an installed one. In electron-builder 26, the default extraction directory is
a build-time ksuid: it is stable for one artifact, but changes between builds.
The taskbar fix therefore needs an explicit name, while also accounting for
the portable launcher's cleanup and shared-directory behavior.

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
7. The portable target uses the fixed per-user temp directory name
   `PI-Desktop-Portable` for extraction. The packaged executable therefore
   resolves to `%TEMP%\PI-Desktop-Portable\PI-Desktop.exe` while running and
   on the next launch, including across portable builds. The launcher still
   removes that directory before extraction and after the app exits; this is a
   stable runtime identity, not a persistent installation or pin target.

## Consequences

- Windows users who cannot run an installer can download and launch one
  executable from the GitHub Release.
- Portable users discover updates in-app and open the releases page; they
  replace the portable file themselves.
- NSIS in-app updates, hashes, and feed ownership are unchanged.
- The portable process still unpacks application files under the Windows temp
  directory for that launch, using the stable `PI-Desktop-Portable` directory
  name. The launcher deletes the directory on exit, so a taskbar pin that
  targets the unpacked executable may be missing or show a blank icon while
  the app is stopped; the next launch recreates the path and restores the
  running-window identity. Whitelisting applies to the downloaded portable
  executable; a policy that also blocks temp-directory execution may still
  require the NSIS install.
- All portable wrappers for one user, including different versions, share the
  extraction directory. Do not launch two portable wrappers concurrently or
  replace one while another is running: the second launcher can remove or
  overwrite the first launch's files before Electron's single-instance lock
  is acquired. An installed NSIS copy uses a separate tree.

## Alternatives considered

- Zip of `win-unpacked` only: rejected as the requested artifact is a
  no-install `.exe`.
- In-app update of portable via the NSIS installer: rejected because it would
  install the application and require a whitelisted installer.
- Beside-the-exe data directory: rejected as an unrelated data-ownership
  change; `PI_DESKTOP_DATA_DIR` already relocates the profile when needed.
