# ADR 0148: Explicitly disable application keyboard shortcuts

- Status: Accepted
- Date: 2026-09-03
- Related: ADR 0072, ADR 0076, issue #31

## Context

Deleting a shortcut override always restored the default, so users could not
intentionally unbind an action, and a null-like value was silently resolved back to
the default.

## Decision

`AppSettings.keybindings` uses three states per shortcut: an absent property uses
the platform default, a portable binding string overrides it, and an explicit JSON
`null` means `Unbound` and disables dispatch, while invalid strings still fall back
to the default. Settings exposes Disable separately from Restore default, shows a
localized Unbound state, and keeps unbound actions out of conflict checks. An
unbound `openPluginLauncher` unregisters the global accelerator, disables the
host-core `Alt+Space` hook on Windows, and turns configurable macOS native-role
items into role-less clickable items.

## Consequences

- Any built-in shortcut can be disabled without losing Restore default or a new
  binding, and macOS menu clicks stay available while a shortcut is unbound.
- `resolveKeybinding` returns `string | null`, so every consumer must handle the
  no-binding state explicitly.
- Existing settings keep their behavior; only newly persisted `null` values disable
  actions.
