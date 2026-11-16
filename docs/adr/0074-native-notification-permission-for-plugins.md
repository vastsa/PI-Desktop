# ADR 0074: Native notification permission for plugins

- Status: Accepted
- Date: 2026-08-12

## Context

The plugin `notify` capability exposed only an in-app Toast, while native
notifications already existed for terminal task outcomes behind the
application-owned task inbox. Plugins need OS notification access without
gaining Electron objects or the inbox, but Electron offers no cross-platform
read-only permission query and no separate request method, so native delivery
can only report success through the notification lifecycle.

## Decision

Keep `pi.ui.notify` as the backwards-compatible in-app Toast and add three
permission-gated APIs under `pi.ui`: `getNotificationPermission()` returning
`granted`, `denied`, `unknown`, or `unsupported`; `requestNotificationPermission()`
running a short native probe and returning the best-effort result;
`showNativeNotification({ title, body? })` returning `{ shown, permission }`.
All three use the existing low-risk manifest `notify` permission, the Electron
main process owns the native objects and length limits, and plugin
notifications never create inbox rows or session activation on click.

## Consequences

- Plugins can send OS-level reminders while staying behind the existing
  permission review, and existing plugins keep their Toast behavior.
- A plugin must handle `unknown`, `denied`, and `unsupported` instead of assuming
  a banner was delivered.
- The task inbox stays application-owned and cannot be used as plugin
  persistence or navigation.

## Alternatives

- Replace `pi.ui.notify` with native delivery: it silently changes existing
  plugin behavior and conflates Toasts with OS notifications.
- Let plugins construct Electron `Notification` objects: rejected by the plugin
  isolation boundary.
