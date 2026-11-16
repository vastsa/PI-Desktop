# ADR 0094: Admit one desktop instance per data directory

- Status: Accepted
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D236, D002, D216, ADR 0078, ADR 0090

## Context

Nothing stopped a second PI-Desktop process from starting. Launching the app
again while it was already running — a double click on Windows or Linux, a `open
-n` or a packaged app started next to a development host on macOS, or a
tray-resident session the user assumed had exited — booted a complete second
copy: another host-core over the same `pi.sqlite`, another persistence outbox
and log tree in the same data directory, another agent sidecar, another tray
icon, another global launcher shortcut registration, and another updater.

## Decision

1. Electron main takes `app.requestSingleInstanceLock()` during module
   evaluation, after `app.setName` (the lock file lives under the name-derived
   `userData` path) and before anything reads or writes the data directory.
2. A launch that does not get the lock calls `app.quit()` immediately and boots
   nothing.
3. The instance that holds the lock handles `second-instance` by restoring and
   focusing its main window through the same path as the tray's Show action,
   which recreates a window that was closed or hidden into the tray.
4. The lock is requested only when `PI_DESKTOP_DATA_DIR` is unset.

## Consequences

- One installation is one process: one host-core, one SQLite writer, one outbox,
  one tray, one launcher shortcut binding, one updater.
- Relaunching the app is a reliable way back to a tray-hidden or closed window,
  alongside the tray, the Dock, and `did-become-active` (ADR 0078, ADR 0086).
- E2E harnesses, the capture rig, and side-by-side profiles are unaffected
  because they set `PI_DESKTOP_DATA_DIR`.
- Two runs that are pointed at the *same* explicit data directory are still
  admitted.

## Alternatives

### Relocate `userData` under `PI_DESKTOP_DATA_DIR`

This would scope the lock to the resource that actually cannot be shared.

### Keep a lock file in the data directory

Rejected because it re-implements what Electron already provides and still has
no channel to raise the running window; a stale lock file after a crash would
also block the app with no recovery path.

### Let the second launch focus the first and stay alive

Rejected because a resident duplicate keeps a second Electron process, tray, and
shortcut registration for no purpose.

### Do nothing and document the hazard

Rejected because the failure is silent data divergence over a single-writer
database, and the user has no signal that two shells are open on one workspace.

## Amendment (D599)

The alternatives below still stand: the lock is not scoped to
`PI_DESKTOP_DATA_DIR`, and `userData` is not relocated under it.

What changed is that a development build is no longer the same installation as
the packaged app. It takes `PI-Desktop Dev` in the OS application-data root and
`~/.pi-desktop-dev`, so `pnpm dev` starts while the packaged app holds its lock
and the two never share `pi.sqlite`, the outbox, or the log tree.

## Amendment: explicit storage relocation (2026-10-01)

Issue #1213 adds an explicitly confirmed, offline relocation of the complete app
and Chromium profile. The stable `userData` installation lock is retained, while
Chromium `sessionData` may follow the copied browser profile.
