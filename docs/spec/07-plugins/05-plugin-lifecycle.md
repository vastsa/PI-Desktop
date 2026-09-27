# 05. Plugin Lifecycle

## 1. Goals

Define the complete state machine from discovery to uninstall, guaranteeing:

- Predictable behavior
- Recoverable failures
- Auditable start/stop
- Consistency with command palette / AgentTool registration

## 2. State machine

```text
discovered
 → validated
 → installed
 → enabled
 → loaded
 → running
 → load_error
 → disabled
 → install_error
 → invalid
```

### State descriptions

| State | Meaning |
|---|---|
| discovered | Plugin directory or package scanned |
| validated | manifest / file integrity passed |
| installed | Written to the installed directory and registered |
| enabled | Enabled by the user, allowed to load |
| loaded | Runtime loaded, contribution points registered |
| running | Has an active panel / background logic |
| disabled | Installed but turned off by the user |
| load_error | Load failed after enabling |
| install_error | Install failed |
| invalid | Validation failed, unusable |

## 3. Lifecycle hooks

**Implemented today:** the runtime (`apps/desktop/electron/main/plugin-runtime.ts`) invokes `onLoad` (when a plugin is loaded on load/enable) and `onUnload` (dispatched into the plugin process on unload/disable/reload/app quit, 5s budget — 1.5s on quit — then the process is stopped); unloading tears down the plugin's registered commands and tools. The other hooks below are declared in the API but not yet fired.

**Planned:** once the full lifecycle lands, hooks fire in this order:

1. `onInstall` (once, only after a successful install)
2. `onEnable`
3. `onLoad`
4. runtime events
5. `onUnload`
6. `onDisable`
7. `onUninstall`

### Invocation constraints
- Hooks must be able to time out (default 5s, configurable)
- A hook exception must not crash the host
- If `onLoad` fails, enter `load_error` and automatically roll back the contribution points already registered

## 3.1 Resident services

A service declared in `contributes.services` is driven by the host, not by the
plugin's own hooks, so its window is strictly inside the plugin's lifetime:

1. `onLoad` completes and contribution points are registered
2. For each declared service (at most 4 per plugin, gated on
   `background.service`), the broker calls `service.start` in the plugin process
   with a 5s budget. A start failure marks that one service `failed` and leaves
   the rest of the plugin loaded.
3. On unload / disable / reload, `service.stop` runs **before** `onUnload`, so
   the service is quiet while the plugin still has its API

Status per service is `starting` | `running` | `stopped` | `failed` plus a
restart count, readable over the plugin IPC surface and shown on the Plugins
page.

### Restart policy

The service lives in the plugin's host process, so a crash takes it with the
process. The supervisor then restarts the whole plugin:

- Backoff `1s, 2s, 4s, 8s, 16s`, capped at 30s
- At most 5 restarts; after that the plugin stays down in `failed` so the user
  sees the failure instead of a silent crash loop
- A process that survives 60s is considered healthy and the backoff resets to
  zero
- `autoRestart: false` on a service opts its plugin out of restarts entirely
- Restarts are skipped when the user re-enabled or removed the plugin while the
  backoff timer was pending

Manual enable / disable always wins over the supervisor: an explicit action
clears the pending timer and the attempt counter.

### App quit

Quitting stops every plugin host **as a shutdown**, not as a crash. Each plugin
is marked as disposing and its pending restarts are cancelled before anything
else, then services stop and `onUnload` runs, in parallel across plugins.

This is what separates the two exits: a host process that dies without being
marked is reported as a crash, which means an error log, a "stopped
unexpectedly" toast, and a supervisor scheduling restarts into an app that is
closing. None of that may happen on a clean quit.

The sequence is bounded — `onUnload` gets 1.5s per plugin and teardown 3s in
total, after which the children are killed outright. A plugin's cleanup must
never be the reason the app appears to hang on quit.

## 4. Enable / disable semantics

### enable
- Set state to enabled
- Attempt load
- Success: register commands / tools / skills / themes / MCP servers, then start
  resident services
- Failure: automatically fall back to disabled and surface the error to the user. This is frozen by D017 (enable→load failure auto-disables the plugin).

### disable
- Unregister commands / tools
- Close panel
- Stop resident services and disconnect MCP servers
- Cancel any pending restart backoff
- Call `onUnload` / `onDisable`
- Persist as disabled

## 5. Startup recovery

On app startup:

1. Scan installed plugins
2. Read the enabled state
3. Load only enabled plugins
4. Skip a single failed plugin without affecting other plugins or the main app

## 6. Developer mode

`dev-loaded` plugins:

- Not copied to `installed`
- Reference the local path directly
- Can watch and hot reload
- Reload flow: `unload → validate → load`

On hot reload:
- Preserve plugin settings as much as possible
- Panel in-memory state is not guaranteed to be preserved

## 7. Contribution-point register/unregister transaction

Each plugin's load process should be approximately transactional:

```text
begin
 register commands
 register tools
 register skills
 register themes
 register MCP servers (lazy connect)
commit
 start resident services
```

On mid-way failure:
```text
rollback all registrations from this plugin
```

Avoid a half-loaded state where "the command exists but the tool does not".

## 8. Audit events

Record at least:

- plugin.install
- plugin.uninstall
- plugin.enable
- plugin.disable
- plugin.load.success
- plugin.load.error
- plugin.unload
- plugin.crash
- plugin.service.start / plugin.service.stop
- plugin.service.restart / plugin.service.restart.scheduled
- plugin.services.skipped (missing permission or over the per-plugin cap)

Fields:
- pluginId
- version
- source (`installed` | `dev` | `marketplace`)
- ts
- errorCode?
- attempt? / delayMs? (service restarts)

## 9. Uninstall strategy

Before uninstall:
1. disable + unload
2. Call `onUninstall`
3. Delete installed files
4. Clean up plugin-private data (may ask the user whether to keep it)

Default recommendation:
- Clean up settings/data on uninstall (D016: uninstall deletes plugin data by default)
- Provide a "keep data" advanced option (can be deferred)
