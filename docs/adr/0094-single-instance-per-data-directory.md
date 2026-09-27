# ADR 0094: Admit one desktop instance per data directory

- Status: Accepted
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D236, D002, D216, ADR 0078, ADR 0090

## Context

Nothing stopped a second PI-Desktop process from starting. Launching the app
again while it was already running — a double click on Windows or Linux, a
`open -n` or a packaged app started next to a development host on macOS, or a
tray-resident session the user assumed had exited — booted a complete second
copy: another host-core over the same `pi.sqlite`, another persistence outbox
and log tree in the same data directory, another agent sidecar, another tray
icon, another global launcher shortcut registration, and another updater.

host-core owns SQLite exclusively (D002) precisely so there is a single writer.
A second app process defeats that: the two shells show divergent session lists
over one database, the second registration of the launcher chord silently loses,
and quitting one of them tears down state the other is still using. The user's
mental model is one desktop app; the process model was the only thing that
disagreed.

The data directory is what cannot be shared, but Electron's single-instance lock
is scoped to `userData`, not to `PI_DESKTOP_DATA_DIR`. Runs that point at their
own data directory — the E2E harnesses, the capture rig, a deliberate
side-by-side profile — share no state with the default installation and must
stay launchable while one is running.

## Decision

1. Electron main takes `app.requestSingleInstanceLock()` during module
   evaluation, after `app.setName` (the lock file lives under the name-derived
   `userData` path) and before anything reads or writes the data directory.
2. A launch that does not get the lock calls `app.quit()` immediately and boots
   nothing. The readiness handler and the shutdown handler both return early for
   it, so it never creates a window, a tray, a child process, or a log line in
   the running instance's data directory.
3. The instance that holds the lock handles `second-instance` by restoring and
   focusing its main window through the same path as the tray's Show action,
   which recreates a window that was closed or hidden into the tray.
4. The lock is requested only when `PI_DESKTOP_DATA_DIR` is unset. A run given
   its own data directory keeps the current start-anytime behavior.

## Consequences

- One installation is one process: one host-core, one SQLite writer, one
  outbox, one tray, one launcher shortcut binding, one updater.
- Relaunching the app is a reliable way back to a tray-hidden or closed window,
  alongside the tray, the Dock, and `did-become-active` (ADR 0078, ADR 0086).
- E2E harnesses, the capture rig, and side-by-side profiles are unaffected
  because they set `PI_DESKTOP_DATA_DIR`.
- Two runs that are pointed at the *same* explicit data directory are still
  admitted. That combination is a deliberate act, not an accidental relaunch,
  and scoping the lock to it would mean relocating `userData` under the data
  directory and discarding renderer-local state for every profile user.

## Alternatives

### Relocate `userData` under `PI_DESKTOP_DATA_DIR`

This would scope the lock to the resource that actually cannot be shared.
Rejected because `userData` also holds renderer `localStorage` (retained project
tabs and sidebar presentation, D093), plugin panel partitions, and browser pane
cookies; moving it would silently discard that state for existing profile users
to close a rare edge case.

### Keep a lock file in the data directory

Rejected because it re-implements what Electron already provides and still has
no channel to raise the running window; a stale lock file after a crash would
also block the app with no recovery path.

### Let the second launch focus the first and stay alive

Rejected because a resident duplicate keeps a second Electron process, tray, and
shortcut registration for no purpose. Quitting immediately is the same visible
result with none of the cost.

### Do nothing and document the hazard

Rejected because the failure is silent data divergence over a single-writer
database, and the user has no signal that two shells are open on one workspace.
