# 12. Plugin IPC and Host Services

## 1. Goals

Complete the plugin-related host services and UI IPC so implementation does not rely on ad-hoc conventions.

## 2. Main-process services

```text
PluginManager
 ├─ PluginRegistryStore
 ├─ ManifestValidator
 ├─ PackageInstaller
 ├─ PermissionGateway
 ├─ ContributionRegistry
 │ ├─ CommandRegistry
 │ ├─ AgentToolRegistry
 │ ├─ SkillRegistry
 │ ├─ ThemeRegistry
 │ └─ McpServerRegistry
 ├─ PluginRuntimeBroker
 │ ├─ ServiceSupervisor
 │ └─ MessageBus
 ├─ PluginPanelHostService
 └─ MarketClient
```

## 3. UI IPC (additions)

### plugin domain
- `plugin/list`
- `plugin/detail`
- `plugin/loadDev` — open the folder picker and return what the folder
  *declares* as a permission review; nothing is registered yet
- `plugin/loadDevConfirm` — the answer to that review: register the folder as a
  development plugin and load it with the accepted permissions, which become
  the ceiling every later hot reload is measured against
- `plugin/reload` — resolve the registered plugin path, compare the manifest
  against the recorded approval, and either reload in Electron main or return a
  review when the manifest now asks for more
- `plugin/reloadConfirm` — the answer to that review: reload under the accepted
  permissions and refresh the development-plugin permission ceiling
- `plugin/installFromPath` ✅
- `plugin/installFromPackage` ✅
- `plugin/enable`
- `plugin/disable`
- `plugin/uninstall`
- `plugin/reload`
- `plugin/getLogs`
- `plugin/getPermissions`
- `plugin/grantPermissions`
- `plugin/revokePermissions`
- `plugin/openDataDir`
- `plugin/openInstallDir`
- `plugin/openPanel`
- `plugin/setAutoUpdate`
- `plugin/themes` ✅ — every loaded plugin's sanitized theme CSS, for the theme
  picker and the injected `<style>` element
- `plugin/services` ✅ — resident service status (`starting` | `running` |
  `stopped` | `failed`) plus the restart count, for the Plugins page chips

### commandPalette domain
- `commandPalette/search`
- `commandPalette/execute`
- `commandPalette/listRecent`

### market domain (implemented)
- `market/search`
- `market/getDetail`
- `market/install`
- `market/checkUpdates`
- `market/applyUpdates`
- `market/listProviders` (single official provider for now)

## 4. Events (main → renderer)

- `plugin/event/changed` (installed/enabled change)
- `plugin/event/loadError`
- `plugin/event/permissionRequired`
- `market/event/updateAvailable`

The shipped `pluginChanged` event carries a `reason` so the renderer can decide
what to refetch: `install`, `loadDev`, `enable`, `disable`, `uninstall`, `crash`,
`service`, `market.install`, `market.applyUpdates`, `themes` (runtime
`themes.upsert` / `themes.remove`). `service` fires on every
supervision transition and is the cheapest of them — only the service list needs
a reload.

`settingsChanged` (`pi-desktop/app/event/settingsChanged`) carries a settings
patch when the **host** writes app settings outside the renderer path — today
only plugin `app.setTheme` (`{ theme }`). The renderer merges the patch into
its store so the shell paints the new preference.

Panel bridge fixed channels also include `app.setTheme`, `themes.upsert`,
`themes.remove`, and `themes.list` (all require `ui.theme`).

## 4.1 Events (host → plugin process)

The broker also pushes one-way frames down to a plugin's `utilityProcess`:

```text
{ t: "event", event: "bus.message", subscriptionId, message }
```

There is no reply frame and no backpressure: delivery is fire-and-forget so a
wedged subscriber cannot stall the publisher. The child dispatches to the handler
registered for `subscriptionId` and to any `pi.events.on` listener; a throwing
handler is logged, never fatal. This is the same channel that finally makes
`pi.events.on` / `off` real (see
[03-plugin-api.md](03-plugin-api.md) §5).

## 5. ContributionRegistry behavior

### Registration
- key must be unique
- Plugin commands share the prefix: `plugin.<pluginId>.<commandId>`
- Plugin tool prefix policy: `plugin_<pluginIdSafe>_<toolName>` (fixed in the implementation)

### Query
- The command palette only queries contributions that are enabled + loaded successfully
- Agent sees registered tools; Plan receives no plugin tools regardless of risk
  or grant state

### Deregistration
- Remove everything on disable/unload/uninstall, including stopping resident
  services, disconnecting MCP servers, dropping bus subscriptions, and removing
  the plugin's themes from the picker

## 6. RuntimeBroker call chain

Plugin API call:

```text
plugin runtime
 → RPC to PluginRuntimeBroker
 → PermissionGateway.check
 → Host service execute
 → audit log
 → response
```

### 6.1 Allowlist names and audit operations for the real-time capabilities

The broker's `HOST_API_ALLOWLIST` gains three implemented entries, all gated on
`keyboard.globalShortcut`:

- `keyboard.registerGlobalShortcut`
- `keyboard.unregisterGlobalShortcut`
- `keyboard.listGlobalShortcuts`

Their audit operations are `keyboard.globalShortcut.register`,
`keyboard.globalShortcut.unregister`, and `keyboard.globalShortcut.trigger` (a
shortcut that fired). Register and trigger entries record the accelerator and
command; no key events and no input text are ever recorded.

The socket capability is implemented: `net.websocket.connect` /
`net.websocket.send` / `net.websocket.close` are registered in the same
allowlist, gated on `net.websocket`. Its audit operations are
`net.websocket.connect` and `net.websocket.close` (plugin id and result, never
payloads, headers, or keys), plus a refused `net.websocket.send`; a successful
send is not audited. Frames travel back to the owning plugin only, as the host
events `net:websocket:open`, `net:websocket:message`, `net:websocket:close`,
and `net:websocket:error`.

The audio names are registered in the same allowlist:
`audio.getInputDevices`, `audio.openInput`, `audio.closeInput`,
`audio.getCaptureState`, `audio.onInputFrame`, `audio.offInputFrame`,
`audio.openOutput`, `audio.writeOutput`, `audio.stopOutput`, and
`audio.closeOutput`. The permission gate runs first, so an ungranted call is
refused with `PERMISSION_DENIED` under `audio.capture.background` /
`audio.playback.background`, exactly like any other gated API. This host has no
device backend yet, so every call that passes the gate is audited as an
`UNSUPPORTED` refusal — `{ api: "audio.<method>", ok: false, errorCode: "UNSUPPORTED" }` —
and rejected with that code; the two synchronous registration helpers
`audio.onInputFrame` / `audio.offInputFrame` throw it synchronously. Reserved
audit-operation names for the device service: `audio.input.open` /
`audio.input.close`, `audio.output.open` / `audio.output.stop` /
`audio.output.close` (ADR 0257).

## 7. PanelHost interaction

- Create an isolated view when opening a panel
- Pass in pluginId / theme tokens
- Destroy the view and message subscriptions on close. Cleanup that needs a
  `webContents` identity copies that id before the window is destroyed; the
  `closed` handler must not read `webContents` on a destroyed window, or the
  host surfaces an uncaught `TypeError: Object has been destroyed`.
- The preload exposes `pluginBridge.getDroppedFilePath(file)` without exposing
  Node to the page. A panel may call `fs.registerDropped` with that path; the
  host consumes a sender-bound recent drop record once and issues a one-file
  read grant for `fs.stat` / `fs.readRange`.

Panel bridge file channels are permission-gated as follows:

| Channel | Required permission |
|---|---|
| `fs.readText`, `fs.stat`, `fs.readRange`, `fs.readPreview`, `fs.openDefault`, `fs.reveal`, `fs.glob`, `fs.list` | `fs.read` |
| `fs.registerDropped` | `fs.read` plus a real drop gesture |
| `fs.writeText` | `fs.write` |

## 8. Failure isolation

- Plugin API timeout: return TIMEOUT
- runtime crash: mark load_error, clean up contributions
- panel crash: only close the panel, do not unload the plugin (can prompt to reload)

**Implemented (2026-07-29, ADR 0008):** the broker lives in
`electron/main/plugin-runtime.ts` and every plugin call is a request to the
plugin's own `utilityProcess`. Budgets: load 15s, lifecycle hook 5s, command 30s,
tool 110s (under host-core's 150s dispatch budget). On process exit the broker
rejects pending calls with `PLUGIN_CRASHED`, deregisters that plugin's commands
and tools, closes its panel, writes a `plugin.crash` audit entry, and emits a
toast plus `pluginChanged` to the renderer.

## 9. Acceptance

1. The plugin list IPC works
2. The command palette IPC can execute plugin commands
3. Start/stop triggers contribution registration/deregistration
4. The market IPC runs end-to-end under a mock provider (later milestone)

## Appendix: agent-tool dispatch protocol (implemented M5)

Plugin agent tools execute in the desktop runner (Electron main), while the
permission gate and result envelope stay in host-core:

1. Model calls `plugin_<pluginIdSafe>_<toolName>`; the sidecar forwards it
   to host `tools.execute` like any built-in tool.
2. host-core resolves the durable operating mode first. In Agent it runs the
   normal permission flow (risk, session grants, 120s timeout), then emits
   notification `plugins.execute`
   `{ executionId, sessionId, toolCallId, toolName, args, turnId }`. `turnId` is
   the runtime turn identity, forwarded unchanged so the plugin tool context can
   be matched against the `session:turnEnded` event.
3. Plan calls fail at the host policy step with `PLUGIN_DISABLED_IN_PLAN`; they
   never reach Electron or the plugin runtime. Agent calls continue with
   Electron main executing the registered plugin tool JS and answering via RPC
   `plugins.resolveExecution` `{ executionId, ok, content, errorCode? }`.
4. host-core resolves the pending execution and returns a standard
   `ToolsExecuteResult` to the sidecar. Dispatch waits up to 150s
   (`DESKTOP_TOOL_DISPATCH_TIMEOUT_MS`, above both the 110s plugin tool budget
   and the widest MCP leg — a 10s lazy handshake, a 30s `tools/list` traversal,
   then the 100s call) and then maps to `TOOL_TIMEOUT`; an unknown/unloaded tool
   maps to `TOOL_NOT_FOUND`. The transport deadline for these calls covers the
   120s permission wait, the 30s admission queue wait, that dispatch, and 10s of
   slack (`rpcTimeoutMs`), so no outer layer gives up before host-core reports
   the outcome.

The model-facing registry gains plugin tools per prompt: main passes registered
defs (`fullName`, description, JSON-schema parameters) to `agent.prompt`, and
the runtime keeps them in a deferred catalog instead of serializing every
schema into the first request. The model loads a matching plugin tool through
the local `tool_search` tool; the next turn receives the selected schema and
then uses the same host permission/dispatch path above. Covered by protocol
smoke scenario E2E-024 and the runtime-loading scenario E2E-008a.

Tools discovered from a plugin's MCP servers enter the same registry under
`plugin_<pluginIdSafe>_<serverId>_<toolName>`, so steps 1–4 above are unchanged;
only step 3 differs internally, forwarding to the MCP client instead of plugin JS.

Skills use a separate, simpler path. The catalog (id, name, description) is part
of the base system prompt, the `skill` schema is itself deferred behind
`tool_search`, and its body is fetched by a local `skill` tool that Electron main
serves directly — the sidecar never holds skill text, and a skill document
reaches the model only when it asks for it (D174/D185).
