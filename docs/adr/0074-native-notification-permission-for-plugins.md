# ADR 0074: Native notification permission for plugins

- Status: Accepted
- Date: 2026-08-12

## Context

The plugin `notify` capability currently exposes only an in-app Toast.
PI-Desktop already uses Electron's native notification API for terminal task
outcomes, but that surface is intentionally owned by the application and backed
by the durable task notification inbox.

## Decision

Keep `pi.ui.notify` as the backwards-compatible in-app Toast. Add three
permission-gated APIs under `pi.ui`:

- `getNotificationPermission()` returns `granted`, `denied`, `unknown`, or
  `unsupported`.
- `requestNotificationPermission()` performs a short native notification probe
  and returns the best-effort result.
- `showNativeNotification({ title, body? })` sends a native notification and
  returns `{ shown, permission }`.

All three APIs use the existing low-risk manifest `notify` permission. The
Electron main process owns the native objects, limits title/body lengths, and
keeps plugin notifications separate from the durable task inbox.

## Consequences

- Plugins can provide OS-level reminders and status updates while remaining
  behind the existing plugin permission review.
- Existing plugins keep their Toast behavior and source compatibility.
- A plugin must handle `unknown`, `denied`, and `unsupported` without assuming
  that a native banner was delivered.
- The task notification inbox remains application-owned and cannot be used as a
  plugin persistence or navigation channel.

## Alternatives considered

- Replacing `pi.ui.notify` with native delivery: rejected because it silently
  changes existing plugin behavior and conflates Toasts with OS notifications.
- Adding a platform-specific permission package: rejected for this API revision;
  it would add platform-specific dependencies without a common Electron
  permission contract.
- Allowing plugins to construct Electron `Notification` objects: rejected by the
  plugin isolation boundary.
