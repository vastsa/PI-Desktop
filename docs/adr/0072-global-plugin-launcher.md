# ADR 0072: Add a global plugin launcher

- Status: Accepted for implementation
- Date: 2026-08-11
- Deciders: PI-Desktop core
- Related: D211 · [Settings IA](../spec/04-ux/06-settings-ia.md) ·
  [Interaction patterns](../spec/04-ux/09-interaction-patterns.md) · E2E-120

## Context

Installed plugin panels are reachable from the Plugins destination, but opening
one interrupts the user's current work and requires pointer navigation. A
system-wide shortcut needs a dedicated native window: the normal renderer cannot
receive keys while PI-Desktop is unfocused, and the existing plugin panel host
should remain the only authority that opens plugin UI.

## Decision

1. Add the shared, customizable `openPluginLauncher` shortcut, defaulting to
   `Alt+Space`.
2. Electron main owns one centered, frameless 620×440 utility window on the
   display nearest the pointer.
3. The sandboxed launcher renderer uses the existing preload and the additive
   Electron-only toggle, dismiss, and shown channels.
4. Only enabled, ready plugins with a panel are candidates.

## Consequences

- A plugin panel can be opened without navigating away from the current task.
- The shortcut remains visible and resettable in Settings → Shortcuts.
- `pinyin-pro` is bundled into renderer output rather than shipped as a runtime
  package tree.
- A custom shortcut continues to use Electron's global shortcut API.
- The renderer IPC additions remain Electron-local and additive; the native
  fallback adds one host method/notification without changing protocol v9 or
  storage schema v11.

## Alternatives considered

### Reuse global search

Rejected. Global search is part of the main renderer and cannot appear while the
application is unfocused without first restoring the entire main window.

### Open plugins directly from a native menu

Rejected. A static menu cannot provide Chinese/pinyin fuzzy search and would
need to be rebuilt for every plugin lifecycle change.

### Put pinyin aliases in plugin manifests

Rejected. It makes search quality depend on every plugin author and duplicates
data that can be derived consistently at query time.
