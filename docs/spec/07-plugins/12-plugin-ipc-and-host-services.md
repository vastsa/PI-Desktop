# 12. Plugin IPC and Host Services

## 1. Goals

Complete the plugin-related host services and UI IPC so implementation does not rely on ad-hoc conventions.

## 2. Main-process services

The following is a logical responsibility map, not a list of exported classes.
`PluginRuntime` implements the broker and contribution registries in
`apps/desktop/electron/main/plugin-runtime.ts`; `ipc/plugin-ipc.ts`,
`ipc/plugin-ui-ipc.ts`, and `ipc/market-ipc.ts` wire the renderer-facing handlers.
Rust host-core owns the durable plugin registry, installation, and marketplace
operations under `crates/host-core/src/plugins/`.

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

These are application-renderer invoke channels from `IPC.invoke` in
`packages/shared/src/protocol.ts`, with the common `pi-desktop/` prefix omitted.
They are not plugin-process APIs or panel bridge channel names. The handler
registrations, rather than the conceptual services above, define what is callable.

### plugin domain
- `plugin/list`
- `plugin/rendererCall`
- `plugin/composerTransform`
- `plugin/importExtension`
- `plugin/loadDev` — open the folder picker and return what the folder
  *declares* as a permission review; nothing is registered yet
- `plugin/loadDevConfirm` — the answer to that review: register the folder as a
  development plugin and load it with the accepted permissions, which become
  the ceiling every later hot reload is measured against
- `plugin/reload` — resolve the registered plugin path, compare the manifest
  against the recorded approval, and either reload in Electron main or return a
  review when the manifest adds permissions or widens file scope
- `plugin/reloadConfirm` — the answer to that review: reload under the accepted
  permissions and refresh the development-plugin permission ceiling
- `plugin/createFromTemplate` — scaffold files and return the same load review;
  scaffolding does not grant permission to load the plugin
- `plugin/installFromPath` ✅
- `plugin/installFromPackage` ✅
- `plugin/enable`
- `plugin/disable`
- `plugin/setScope`
- `plugin/uninstall`
- `plugin/settings/get`
- `plugin/settings/set`
- `plugin/openPanel`
- `plugin/setAutoUpdate`
- `plugin/themes` ✅ — every loaded plugin's sanitized theme CSS, for the theme
  picker and the injected `<style>` element
- `plugin/providerCatalog`
- `plugin/scenicThemes/destinations`
- `plugin/scenicThemes/setBlur`
- `plugin/services` ✅ — resident service status (`starting` | `running` |
  `stopped` | `failed`) plus the restart count, for the Plugins page chips
- `plugin/views`
- `plugin/view/open`
- `plugin/view/close`
- `plugin/view/setBounds`
- `plugin/view/setVisible`
- `plugin/session/active`
- `plugin/composer/suggestionResult`

Plugin details and declared permissions are returned by `plugin/list`; there
are no dedicated detail, log, permission-grant/revoke, or directory-opening
invoke channels in this domain. The launcher uses its separate
`pluginLauncher/toggle` and `pluginLauncher/dismiss` channels.

### commandPalette domain
- `commandPalette/search`
- `commandPalette/execute`

Search combines built-in, active-project plugin, and trusted-extension commands.
Execution rechecks plugin activation scope. Built-in commands return an
acknowledgement for renderer handling; trusted-extension commands use
`extensions/commands/run` with a session, not `commandPalette/execute`.

### market domain (implemented)
- `market/refresh`
- `market/search`
- `market/getDetail`
- `market/install`
- `market/checkUpdates`
- `market/applyUpdates`
- `market/cancelInstall`
- `market/reviewSummaries`
- `market/reviewTickers`
- `market/reviews`

There is no marketplace-provider enumeration invoke channel. Search, detail,
installation, updates, cancellation, and anonymous review reads delegate to
host-core through `ipc/market-ipc.ts`.

## 4. Events (main → renderer)

- `IPC.event.pluginChanged` — `pi-desktop/event/pluginChanged`
- `IPC.event.pluginInstallProgress` — `pi-desktop/plugin/event/installProgress`
- `IPC.event.pluginViewReveal` — `pi-desktop/plugin/view/event/reveal`
- `IPC.event.pluginComposerSuggestion` — `pi-desktop/plugin/composer/event/suggestion`
- `IPC.event.toast` — `pi-desktop/app/event/toast`, including runtime crash and
  development reload feedback

There are no separate load-error, permission-required, or update-available
events in `IPC.event`. Development permission reviews are invoke responses;
update discovery is the result of `market/checkUpdates`. Install/update progress
is forwarded from the host's `plugin.installProgress` notification.

The shipped `pluginChanged` event carries a `reason` so the renderer can decide
what to refetch. Reasons include `install`, `loadDev`, `reload`, `settings`,
`scope`, `enable`, `disable`, `uninstall`, `crash`, `service`, `restore`,
`market.install`, `market.applyUpdates`, and `themes` (runtime `themes.upsert` /
`themes.remove` / `themes.setVariables`). `service` fires on every
supervision transition and is the cheapest of them — only the service list needs
a reload. `restore` fires once when startup recovery has loaded the enabled
plugins, so a surface that listed them earlier still sees them.

`settingsChanged` (`pi-desktop/app/event/settingsChanged`) carries a settings
patch when the **host** writes app settings outside the renderer path — today
only plugin `app.setTheme` (`{ theme }`). The renderer merges the patch into
its store so the shell paints the new preference.

Panel bridge fixed channels also include `app.setTheme`, `themes.upsert`,
`themes.remove`, `themes.list`, and `themes.setVariables` (all require `ui.theme`).
`projects.list` is read-only project metadata and needs no permission; it grants
no file or session access.

## 4.1 Events (host → plugin process)

The broker also pushes one-way frames down to a plugin's `utilityProcess`:

```text
{ t: "event", event: "bus.message", subscriptionId, message }
```

There is no reply frame and no backpressure: delivery is fire-and-forget so a
wedged subscriber cannot stall the publisher. The child dispatches to the handler
registered for `subscriptionId` and to any `pi.events.on` listener; a synchronously throwing
handler is logged, never fatal. This is the same channel that finally makes
`pi.events.on` / `off` real (see
[03-plugin-api.md](03-plugin-api.md) §5).

## 5. ContributionRegistry behavior

### Registration
- Command IDs are preserved as supplied and conventionally named
   `plugin.<pluginId>.<commandId>`; the broker does not prepend or validate that
   namespace. The host rejects registration of another plugin's command ID with
   `CONFLICT`, and rejects removal of another plugin's command with
   `PERMISSION_DENIED`. Same-owner updates, and unregistering an absent ID,
   remain valid.
- Plugin tool prefix policy: `plugin_<pluginIdSafe>_<toolName>` (fixed in the implementation)

### Query
- The command palette only queries contributions that are enabled + loaded successfully
- Agent and Goal see registered tools; Plan sees only tools with non-empty
  runtime `planSafeActions`, and execution rechecks `args.action` against them

### Deregistration
- Remove everything on disable/unload/uninstall, including stopping resident
  services, disconnecting MCP servers, dropping bus subscriptions, and removing
  the plugin's themes from the picker

## 6. RuntimeBroker call chain

Plugin host API call:

```text
plugin utilityProcess: pi.<namespace>.<method>(...args)
 → { t: "call", id, api, args, invocationId? } to Electron main
 → PluginRuntime.handleChildMessage → dispatchHostCall
 → API-specific validation and permission checks
 → host API / injected host service (audit where implemented)
 → { t: "res", id, ok, value } or { t: "res", id, ok: false, error }
 → resolve/reject the plugin's pending promise
```

The reverse direction uses `sendToChild` for initialization, lifecycle hooks,
commands, tools, and plugin callbacks. A panel calls `pi-plugin-panel-invoke`
through preload; built-in bridge channels execute in main, while custom channels
are forwarded to the plugin's `onPanelInvoke` as `panel.invoke` (30s budget).

### 6.1 Allowlist names and audit operations for the real-time capabilities

The broker's `HOST_API_ALLOWLIST` gains three implemented entries, all gated on
`keyboard.globalShortcut`:

- `keyboard.registerGlobalShortcut`
- `keyboard.unregisterGlobalShortcut`
- `keyboard.listGlobalShortcuts`

Their audit operations are `keyboard.globalShortcut.register`,
`keyboard.globalShortcut.unregister`, and `keyboard.globalShortcut.trigger` (a
shortcut that fired). Registration records the accelerator and command;
trigger records the command. No key events or input text are recorded.

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
`audio.closeOutput`. For requests that reach the broker, the permission gate
runs first, so an ungranted call is
refused with `PERMISSION_DENIED` under `audio.capture.background` /
`audio.playback.background`, exactly like any other gated API. This host has no
device backend yet, so every call that passes the gate is audited as an
`UNSUPPORTED` refusal — `{ api: "audio.<method>", ok: false, errorCode: "UNSUPPORTED" }` —
and rejected with that code. The plugin-process helpers `audio.onInputFrame` /
`audio.offInputFrame` instead throw `UNSUPPORTED` locally and synchronously:
they send no host request, perform no host permission check, and produce no
host audit entry. Reserved
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
- Bridge identity belongs to the page, not to the host's list of open surfaces: a
  panel window or a docked view registers its plugin before the document loads and
  releases it only when that page is gone, so a call that arrives while the host is
  closing the surface still reaches its own plugin. A call from a page that is
  already destroyed is settled instead of rejected: its answer can never be read and
  the plugin runtime may already be stopping, so rejecting it would only add an
  `invalid panel invoker` failure to the main log. Shutdown closes the panel and
  view pages, bounded, before `plugins.disposeAll()` and `host.dispose()`.
- The preload exposes `pluginBridge.getDroppedFilePath(file)` without exposing
  Node to the page. A panel may call `fs.registerDropped` with that path; the
  host consumes a sender-bound recent drop record once and issues a one-file
  read grant for `fs.stat` / `fs.readRange`.

Panel bridge file channels are permission-gated as follows:

| Channel | Required permission |
|---|---|
| `fs.readText`, `fs.stat`, `fs.readRange`, `fs.readPreview`, `fs.openDefault`, `fs.openInBrowser`, `fs.reveal`, `fs.glob`, `fs.list`, `fs.requestDirectory` | `fs.read` |
| `fs.registerDropped` | `fs.read` plus a real drop gesture |
| `fs.writeText` | `fs.write` |

## 8. Failure isolation

- Host-to-plugin requests that exceed their `sendToChild` budget reject with
  `TIMEOUT` and send a cancellation frame. Plugin-to-host calls have no generic
  timeout in the child proxy; individual host APIs own their execution budgets.
- Initialization failure unloads the plugin and records `plugin.load.error`.
  An unexpected process exit removes the live plugin and its contributions;
  this path does not persist a `load_error` registry status.
- Panel rendering is isolated from the plugin process. The panel/view hosts
  have no `render-process-gone` handler that automatically closes or reloads a
  crashed page. Initial panel loading is separately bounded at 15s; a load
  timeout rejects with `PANEL_LOAD_TIMEOUT` and destroys the hidden window.

**Implemented (2026-07-29, ADR 0008):** the broker lives in
`apps/desktop/electron/main/plugin-runtime.ts`. Each plugin main module runs in
its own `utilityProcess`; its host API calls travel back to the main-process
broker. Host-to-plugin budgets: load 15s, lifecycle hook 5s, command 30s,
tool 110s (under host-core's default 150s dispatch budget). App shutdown uses
a 1.5s unload-hook budget and a 3s overall plugin-disposal budget. On unexpected
process exit the broker
rejects pending calls with `PLUGIN_CRASHED`, deregisters that plugin's commands
and tools, closes its panel, writes a `plugin.crash` audit entry, and emits a
toast plus `pluginChanged` to the renderer. Declared resident services may
trigger supervised restarts with bounded backoff.

## 9. Acceptance

1. The plugin list IPC works
2. The command palette IPC can execute plugin commands
3. Start/stop triggers contribution registration/deregistration
4. The shipped marketplace IPC delegates to host-core; installation and updates
   refresh enabled plugins, while cancellation and progress report the actual
   host operation

The title plugin uses two narrow plugin session RPC methods after the Electron
broker enforces `session.autoTitle`:

- `plugin.session.autoTitleContext` returns only the first user message and
  first assistant reply, each character-bounded, and only while `title_source`
  is `default`.
- `plugin.session.setAutoTitle` validates the title and updates it only when
  both the expected title and `default` source still match. A successful update
  triggers the ordinary host-owned `sessionsChanged` event.

These methods are additive to host RPC protocol v11. They do not grant access to
`plugin.session.listMessages` or the general session transcript.

## Appendix: agent-tool dispatch protocol (implemented M5)

Plugin agent tools execute in the desktop runner (Electron main), while the
permission gate and result envelope stay in host-core:

1. Model calls `plugin_<pluginIdSafe>_<toolName>`; the sidecar forwards it
   to host `tools.execute` like any built-in tool.
2. host-core resolves the durable operating mode first. In Agent it runs the
   normal permission flow (risk, session grants, no automatic deadline), then emits
   notification `plugins.execute`
   `{ executionId, sessionId, toolCallId, toolName, args, turnId }`. `turnId` is
   the runtime turn identity, forwarded unchanged so the plugin tool context can
   be matched against the `session:turnEnded` event.
3. Plan calls without `planSafeActions` fail at the host policy gate.
   Admitted calls carry mode and the allowed actions; the desktop plugin runner
   rejects missing or unlisted `args.action` before plugin code. Agent/Goal calls
   use the normal permission flow. Electron answers through RPC
   `plugins.resolveExecution` `{ executionId, ok, content, errorCode? }`.
4. host-core resolves the pending execution and returns a standard
   `ToolsExecuteResult` to the sidecar. The default dispatch budget is 150s
   (`DESKTOP_TOOL_DISPATCH_TIMEOUT_MS`, above both the 110s plugin tool budget
   and the widest MCP leg — a 10s lazy handshake, a 30s `tools/list` traversal,
   then the 100s call); an explicit tool `timeoutMs` overrides that default.
   A dispatch timeout maps to `TOOL_TIMEOUT`; an unknown/unloaded tool
   maps to `TOOL_NOT_FOUND`. The `tools.execute` transport has no deadline while
   waiting for the explicit permission decision; after approval, host-core's
   execution budget remains authoritative.

The model-facing registry gains plugin tools per prompt: main passes registered
defs (`fullName`, description, JSON-schema parameters) to `agent.prompt`, and
the runtime keeps them in a deferred catalog instead of serializing every
schema into the first request. The model loads a matching plugin tool through
the local `ToolSearch` tool; the next turn receives the selected schema and
then uses the same host permission/dispatch path above. Covered by protocol
smoke scenario E2E-024 and the runtime-loading scenario E2E-008a.

Tools discovered from a plugin's MCP servers enter the same registry under
`plugin_<pluginIdSafe>_<serverId>_<toolName>`, so steps 1–4 above are unchanged;
only step 3 differs internally, forwarding to the MCP client instead of plugin JS.

Skills use a separate, simpler path. The catalog (id, name, description) is part
of the base system prompt, the `Skill` schema is itself deferred behind
`ToolSearch`, and its body is fetched by a local `Skill` tool that Electron main
serves directly. Main reads the document and returns its body in the local-tool
result; the catalog does not preload skill bodies into the model context. A
skill document reaches the model only when requested (D174/D185). The loaded result
includes the absolute `SKILL.md` location and a sentence naming its parent
directory, so relative references such as `references/foo.md` and `SECRET.md`
resolve against the document that was actually loaded. The catalog remains
unchanged and carries no path metadata.
