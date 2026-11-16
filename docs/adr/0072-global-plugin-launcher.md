# ADR 0072: Add a global plugin launcher

- Status: Accepted for implementation (ADR 0080 supersedes the first-use lazy
  window creation)
- Date: 2026-08-11
- Related: D211, D219, ADR 0080

## Context

Installed plugin panels are reachable only from the Plugins destination, so
opening one interrupts the current task. A system-wide shortcut needs its own
native window, because the renderer cannot receive keys while PI-Desktop is
unfocused and the existing panel host should stay the only authority that opens
plugin UI.

## Decision

1. Add the customizable `openPluginLauncher` shortcut, defaulting to `Alt+Space`,
   registered with `globalShortcut` after boot; because Windows reserves that
   chord for the active window's system menu, host-core also installs a narrow
   low-level keyboard hook for the exact default binding, keeping the focused
   main window as a last-resort fallback.
2. Electron main owns one centered, frameless utility window on the display
   nearest the pointer — warmed after boot per ADR 0080, non-resizable, absent
   from the taskbar, always on top while visible, hidden on blur or Escape.
3. The sandboxed launcher renderer uses the existing preload plus additive
   Electron-only toggle, dismiss, and shown channels, lists plugins through the
   existing plugin API, and opens a result through the existing sandboxed panel
   host, changing no plugin permission or host-core boundary.
4. Only enabled, ready plugins with a panel are candidates; search normalizes
   name, id, and description and derives tone-free full pinyin and initials from
   the display name, and IME composition never dispatches. Successful opens are
   remembered in renderer-local device storage (D219).

## Consequences

- A plugin panel opens without navigating away from the current task, and the
  shortcut stays resettable in Settings → Shortcuts.
- A hook installation failure is logged and the focused-window fallback stays
  usable.

## Alternatives

- Reuse global search: it lives in the main renderer and cannot appear while the
  application is unfocused.
- Put pinyin aliases in manifests: makes search quality depend on every author.
