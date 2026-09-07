# ADR 0148: Explicitly disable application keyboard shortcuts

- Status: Accepted
- Date: 2026-09-03
- Deciders: PI-Desktop core
- Related: Issue #31, E2E-072, ADR 0072, ADR 0076

## Context

The shared application shortcut settings supported a missing override or a
custom binding, but deleting an override always restored the default. Users
could not intentionally unbind an action, and a null-like value was treated as
invalid and then silently resolved back to the default.

## Decision

`AppSettings.keybindings` uses three states per application shortcut:

- an absent property uses the platform default;
- a valid portable binding string overrides the default;
- an explicit JSON `null` means `Unbound` and disables dispatch.

Invalid strings continue to fall back to the default so corrupt or hand-edited
settings do not silently disable product actions. The settings UI exposes
Disable separately from Restore default, displays a localized Unbound state, and
keeps an unbound action out of conflict checks. The application shortcut map is
shared by renderer dispatch, macOS menu accelerators, and the plugin launcher.

When `openPluginLauncher` is unbound, Electron unregisters any previous global
accelerator; Windows also disables the host-core `Alt+Space` hook and focused
window fallback. Configurable macOS native-role items use a role-less clickable
item while unbound, because Electron restores a role's default accelerator when
its accelerator is omitted.

The setting remains in the existing JSON settings object. No new IPC method,
protocol version, storage migration, or plugin-local shortcut behavior is added.
The value is portable and not an Electron accelerator string.

## Consequences

- Users can disable any built-in application shortcut without losing the ability
  to restore its default or record a new binding.
- `resolveKeybinding` returns `string | null`, so all consumers must handle the
  no-binding state explicitly.
- Existing settings retain their behavior; absent and valid string entries are
  unchanged, while only newly persisted `null` values disable actions.
- macOS menu clicks remain available even when their configurable shortcut is
  unbound.
